import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerDeviceProbe } from "./client/device-probe";

export default function contribute(client: PluginClientContext) {
  return registerDeviceProbe(client);
}
