package agentrunner

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json/v2"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"strings"
	"uuid"

	"github.com/unreallabsai/unreal-agent/harness/inbox"
)

const maximumLiveInputBytes = 4 * 1024 * 1024

// User inputs and a restricted set of lifecycle controls share inbox ordering.
// Durable session input events (not successful pipe writes) acknowledge delivery.
func consumeLiveInputs(ctx context.Context, reader io.Reader, inputs *inbox.Inbox) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maximumLiveInputBytes)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var request struct {
			Messages []RequestMessage `json:"messages"`
			Control  *struct {
				ID            string `json:"message_id"`
				Mode          string `json:"mode"`
				ThinkingLevel string `json:"thinking_level"`
				Reason        string `json:"reason"`
			} `json:"control"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request, json.RejectUnknownMembers(true)); err != nil {
			return fmt.Errorf("invalid live input: %w", err)
		}
		if request.Control != nil {
			control := request.Control
			if len(request.Messages) != 0 {
				return errors.New("live frame cannot combine controls and messages")
			}
			if _, err := uuid.Parse(control.ID); err != nil {
				return errors.New("live control requires a UUID message_id")
			}
			message := inbox.ControlMessage{Reason: control.Reason}
			switch control.Mode {
			case "settings":
				switch control.ThinkingLevel {
				case "low", "medium", "high", "xhigh", "max":
				default:
					return errors.New("invalid live reasoning level")
				}
				message.Mode = inbox.UpdateSettings
				message.Parameters = inbox.Settings{ReasoningEffort: reasoningEffort(control.ThinkingLevel)}
			case "hard":
				if control.ThinkingLevel != "" {
					return errors.New("hard stop does not accept settings")
				}
				message.Mode = inbox.StopHard
			default:
				return errors.New("unsupported live control")
			}
			payload, err := json.Marshal(message)
			if err != nil {
				return err
			}
			if err := inputs.Submit(ctx, inbox.Input{ID: inbox.ID(control.ID), Kind: inbox.InputControl, Payload: payload}); err != nil {
				return err
			}
			continue
		}
		if len(request.Messages) == 0 || len(request.Messages) > 64 {
			return errors.New("live input requires 1-64 user messages")
		}
		messages, err := validateRequest(Request{Messages: request.Messages})
		if err != nil {
			return fmt.Errorf("invalid live input: %w", err)
		}
		// Validate the entire frame before submitting any message.
		for _, message := range messages {
			if strings.TrimSpace(message.Content) == "" || message.MessageID == nil {
				return errors.New("live messages require nonempty content and a UUID message_id")
			}
		}
		for _, message := range messages {
			payload, err := json.Marshal(message.Content)
			if err != nil {
				return err
			}
			id := strings.TrimSpace(*message.MessageID)
			if _, err := uuid.Parse(id); err != nil {
				return err
			}
			if err := inputs.Submit(ctx, inbox.Input{ID: inbox.ID(id), Kind: inbox.InputExternal, Payload: payload}); err != nil {
				return err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("live input channel closed")
}

// Node's child stdin may be a blocking file descriptor. Closing an unpollable
// os.File does not interrupt a blocked read on macOS. Duplicate it, mark it
// nonblocking, and wrap it again so Go's poller owns cancellation/Close.
func prepareLiveReader(input io.Reader) (io.ReadCloser, error) {
	if file, ok := input.(*os.File); ok {
		fd, err := unix.Dup(int(file.Fd()))
		if err != nil {
			return nil, err
		}
		unix.CloseOnExec(fd)
		if err := unix.SetNonblock(fd, true); err != nil {
			unix.Close(fd)
			return nil, err
		}
		reader := os.NewFile(uintptr(fd), "live-stdin")
		if reader == nil {
			unix.Close(fd)
			return nil, errors.New("cannot open live stdin")
		}
		return reader, nil
	}
	reader, ok := input.(io.ReadCloser)
	if !ok {
		return nil, errors.New("live stdin must be closeable")
	}
	return reader, nil
}

// Kernel-owned locks release even after a crash. Never remove the lock file:
// unlinking an in-use inode would let another writer bypass the same lock.
func lockLiveSession(directory string, id *string) (*os.File, error) {
	if id == nil {
		return nil, nil
	}
	locks := filepath.Join(directory, ".locks")
	if err := os.MkdirAll(locks, 0o700); err != nil {
		return nil, err
	}
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(*id)))
	file, err := os.OpenFile(filepath.Join(locks, key), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("session already has an active harness writer: %w", err)
	}
	return file, nil
}
