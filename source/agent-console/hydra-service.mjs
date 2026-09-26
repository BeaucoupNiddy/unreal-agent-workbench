export const hydraServiceLabel = "local.unreal-agent.hydra";

export function servicePid(output) {
  const match = output.match(/^\s*pid = (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

export function assertManagedHydra(output, daemonPid) {
  const pid = servicePid(output);
  if (!pid || pid !== daemonPid) {
    throw new Error("Hydra is not running under its independent Unreal Agent service. Stop the manually launched backend and start local.unreal-agent.hydra before continuing.");
  }
}
