package agentrunner

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"uuid"

	"github.com/unreallabsai/unreal-agent/cmd/internal/providers"
	"github.com/unreallabsai/unreal-agent/harness/inbox"
	"github.com/unreallabsai/unreal-agent/harness/llm"
)

func liveFrame(content, id string) string {
	encoded, _ := json.Marshal(struct {
		Messages []RequestMessage `json:"messages"`
	}{
		[]RequestMessage{{Role: "user", Content: content, MessageID: &id}},
	})
	return string(encoded) + "\n"
}

func TestLiveInputValidation(t *testing.T) {
	for _, frame := range []string{
		`{}`, `{"messages":[]}`, `{"messages":[{"content":"hello"}]}`,
		`{"messages":[{"role":"assistant","content":"bad"}]}`,
		`{"messages":[{"content":"hi","message_id":"not-a-uuid"}]}`,
		`{"messages":[],"model":"change-model"}`, strings.Repeat("x", maximumLiveInputBytes+1),
	} {
		ctx, cancel := context.WithCancel(t.Context())
		inputs, _ := inbox.New(ctx, nil)
		err := consumeLiveInputs(ctx, strings.NewReader(frame+"\n"), inputs)
		cancel()
		if err == nil {
			t.Fatalf("accepted invalid frame %.100q", frame)
		}
	}
}

func TestLiveInputDeduplicatesAndPreservesOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	inputs, _ := inbox.New(ctx, nil)
	first, second := uuid.New().String(), uuid.New().String()
	done := make(chan error, 1)
	go func() {
		done <- consumeLiveInputs(ctx, strings.NewReader(liveFrame("one", first)+liveFrame("one", first)+liveFrame("two", second)), inputs)
	}()
	for _, want := range []string{first, second} {
		select {
		case got := <-inputs.Output():
			if string(got.ID) != want {
				t.Fatalf("got %s, want %s", got.ID, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("input not delivered")
		}
	}
	if err := <-done; err == nil {
		t.Fatal("EOF must disconnect the live channel")
	}
	select {
	case got := <-inputs.Output():
		t.Fatalf("duplicate input: %#v", got)
	default:
	}
}

func liveRun(t *testing.T, ctx context.Context, client providers.Client, workspace, sessions, request string, reader *io.PipeReader, stdout, stderr *bytes.Buffer) <-chan int {
	t.Helper()
	done := make(chan int, 1)
	go func() {
		done <- RunMain(ctx, []string{"-workspace", workspace, "-session-directory", sessions, "-live-input", request},
			func(name string) string {
				if name == "OPENAI_API_KEY" {
					return "secret"
				}
				if name == "SHELL" {
					return "/bin/sh"
				}
				return ""
			},
			func() []string { return []string{"PATH=/usr/bin:/bin"} }, reader, stdout, stderr, testConfig(client))
	}()
	return done
}

func waitLive(t *testing.T, done <-chan int) int {
	t.Helper()
	select {
	case code := <-done:
		return code
	case <-time.After(10 * time.Second):
		t.Fatal("runner did not stop")
		return -1
	}
}

func TestLiveInputCancelsModelNotRunner(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader, writer := io.Pipe()
	defer writer.Close()
	started, interrupted := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	client := &fakeClient{respond: func(ctx context.Context, request llm.Request) (llm.Response, error) {
		if count.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			close(interrupted)
			return llm.Response{}, ctx.Err()
		}
		last := request.Input[len(request.Input)-1]
		if last.Type != llm.ItemMessage || last.Data.(llm.Message).Text != "new direction" {
			return llm.Response{}, errors.New("steering missing")
		}
		return llm.Response{ID: "steered", Stop: llm.StopComplete}, nil
	}}
	var stdout, stderr bytes.Buffer
	done := liveRun(t, ctx, client, t.TempDir(), t.TempDir(), `{"prompt":"initial","model":"test"}`, reader, &stdout, &stderr)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("model did not start")
	}
	if _, err := io.WriteString(writer, liveFrame("new direction", uuid.New().String())); err != nil {
		t.Fatal(err)
	}
	if code := waitLive(t, done); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	select {
	case <-interrupted:
	default:
		t.Fatal("old model was not interrupted")
	}
	if count.Load() != 2 {
		t.Fatalf("model calls: %d", count.Load())
	}
}

func TestLiveInputSteersWhileShellIsRunning(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader, writer := io.Pipe()
	defer writer.Close()
	workspace, sessions := t.TempDir(), t.TempDir()
	sessionID := uuid.New().String()
	started, release := filepath.Join(workspace, "started"), filepath.Join(workspace, "release")
	steered := make(chan struct{})
	var count atomic.Int32
	client := &fakeClient{respond: func(ctx context.Context, request llm.Request) (llm.Response, error) {
		switch count.Add(1) {
		case 1:
			args, _ := json.Marshal(map[string]string{"command": "echo running > started; while [ ! -f release ]; do sleep 0.01; done; echo finished"})
			return llm.Response{ID: "tools", Output: []llm.Item{{Type: llm.ItemToolCall, Data: llm.ToolCall{CallID: "slow", Name: "Bash", Arguments: string(args)}}}}, nil
		case 2:
			if _, err := os.Stat(started); err != nil {
				return llm.Response{}, err
			}
			if _, err := os.Stat(release); err == nil {
				return llm.Response{}, errors.New("tool finished before steering")
			}
			found := false
			for _, item := range request.Input {
				if item.Type == llm.ItemMessage && item.Data.(llm.Message).Text == "steer now" {
					found = true
				}
			}
			if !found {
				return llm.Response{}, errors.New("steering absent")
			}
			close(steered)
		}
		return llm.Response{ID: fmt.Sprint("response-", count.Load()), Stop: llm.StopComplete}, nil
	}}
	var stdout, stderr bytes.Buffer
	done := liveRun(t, ctx, client, workspace, sessions, fmt.Sprintf(`{"prompt":"initial","model":"test","session_id":%q}`, sessionID), reader, &stdout, &stderr)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shell did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	id := uuid.New().String()
	if _, err := io.WriteString(writer, liveFrame("steer now", id)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-steered:
	case <-time.After(5 * time.Second):
		t.Fatal("steering waited for shell")
	}
	select {
	case code := <-done:
		t.Fatalf("runner stopped with active tool: %d", code)
	default:
	}
	if err := os.WriteFile(release, []byte("done"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := waitLive(t, done); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), id) || !strings.Contains(stdout.String(), "finished") {
		t.Fatal("input/tool result not persisted")
	}
	// Replaying the same durable input after a completion race must ack without
	// invoking the model again or appending another user message.
	reader2, writer2 := io.Pipe()
	defer writer2.Close()
	var replayOut, replayErr bytes.Buffer
	replayClient := &fakeClient{respond: func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{}, errors.New("duplicate replay invoked the model")
	}}
	replayRequest := strings.TrimSpace(liveFrame("steer now", id))
	replayRequest = replayRequest[:len(replayRequest)-1] + fmt.Sprintf(`,"session_id":%q,"model":"test"}`, sessionID)
	if code := waitLive(t, liveRun(t, ctx, replayClient, workspace, sessions, replayRequest, reader2, &replayOut, &replayErr)); code != 0 {
		t.Fatalf("replay exit %d: %s", code, replayErr.String())
	}
	if !strings.Contains(replayOut.String(), `"type":"live_input_ack"`) || !strings.Contains(replayOut.String(), id) {
		t.Fatal("durable duplicate was not acknowledged")
	}
}

func TestLiveInputDisconnectCancelsModel(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader, writer := io.Pipe()
	started := make(chan struct{})
	client := &fakeClient{respond: func(ctx context.Context, _ llm.Request) (llm.Response, error) {
		close(started)
		<-ctx.Done()
		return llm.Response{}, ctx.Err()
	}}
	var stdout, stderr bytes.Buffer
	done := liveRun(t, ctx, client, t.TempDir(), t.TempDir(), `{"prompt":"initial","model":"test"}`, reader, &stdout, &stderr)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("no model request")
	}
	writer.Close()
	if code := waitLive(t, done); code == 0 {
		t.Fatal("disconnected channel reported success")
	}
	if !strings.Contains(stderr.String(), "live input channel closed") {
		t.Fatal(stderr.String())
	}
}

func TestLiveInputBlockingFileCanBeClosed(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	reader, err := prepareLiveReader(read)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { var one [1]byte; _, err := reader.Read(one[:]); done <- err }()
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not unblock stdin")
	}
}

func TestLiveControlOrderingAndSettings(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	inputs, _ := inbox.New(ctx, nil)
	settings, stop := uuid.New().String(), uuid.New().String()
	frames := fmt.Sprintf(`{"control":{"message_id":%q,"mode":"settings","thinking_level":"high"}}`+"\n"+`{"control":{"message_id":%q,"mode":"hard"}}`+"\n", settings, stop)
	done := make(chan error, 1)
	go func() { done <- consumeLiveInputs(ctx, strings.NewReader(frames), inputs) }()
	for index, want := range []string{settings, stop} {
		select {
		case got := <-inputs.Output():
			if string(got.ID) != want || got.Kind != inbox.InputControl {
				t.Fatalf("unexpected control: %#v", got)
			}
			message, err := got.DecodeControlMessage()
			if err != nil {
				t.Fatal(err)
			}
			if index == 0 && (message.Mode != inbox.UpdateSettings || message.Parameters.(inbox.Settings).ReasoningEffort != llm.ReasoningEffortHigh) {
				t.Fatalf("settings: %#v", message)
			}
			if index == 1 && message.Mode != inbox.StopHard {
				t.Fatalf("stop: %#v", message)
			}
		case <-time.After(time.Second):
			t.Fatal("control not delivered")
		}
	}
	<-done
}

func TestLiveSessionRejectsConcurrentWriters(t *testing.T) {
	directory, id := t.TempDir(), uuid.New().String()
	first, err := lockLiveSession(directory, &id)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lockLiveSession(directory, &id); err == nil {
		second.Close()
		t.Fatal("second writer accepted")
	}
	first.Close()
	recovered, err := lockLiveSession(directory, &id)
	if err != nil {
		t.Fatal(err)
	}
	recovered.Close()
}

func TestFallbackModelSettingsSetMissingCompactionThreshold(t *testing.T) {
	file := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(file, []byte(`{"providers":{"openai":{"info":{"id":"openai","name":"OpenAI"},"models":[{"id":"test","name":"Test","context_window":200000,"compaction_threshold":100000},{"id":"gpt-6-astra","name":"Override","context_window":200000,"compaction_threshold":1}]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(model string) int64 {
		var threshold int64
		client := &fakeClient{respond: func(_ context.Context, request llm.Request) (llm.Response, error) {
			threshold = request.Model.CompactionThreshold
			return llm.Response{ID: "done", Stop: llm.StopComplete}, nil
		}}
		var stdout, stderr bytes.Buffer
		code := RunMain(t.Context(), []string{"-workspace", t.TempDir(), "-session-directory", t.TempDir(), "-model-settings", file,
			`{"prompt":"hello","model":"` + model + `"}`},
			func(name string) string {
				if name == "OPENAI_API_KEY" {
					return "secret"
				}
				return ""
			},
			func() []string { return []string{"PATH=/usr/bin:/bin"} }, strings.NewReader(""), &stdout, &stderr, testConfig(client))
		if code != 0 {
			t.Fatalf("exit %d: %s", code, stderr.String())
		}
		return threshold
	}
	if got := run("test"); got != 100000 {
		t.Fatalf("fallback threshold: %d", got)
	}
	// Built-in thresholds win over the fallback file.
	if got := run("gpt-6-astra"); got != 244800 {
		t.Fatalf("built-in threshold: %d", got)
	}
}
