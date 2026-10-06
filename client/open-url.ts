// Opening a link outside Maestro, for any view: one the host cannot open is said.

import { useToast } from "@getpaseo/plugin/client/react-native";
import { Linking } from "react-native";
import { errorText } from "./format";

/** Opens a link outside Maestro; one the host cannot open is said. */
export function useOpenUrl() {
  const toast = useToast();
  return (url: string) => {
    Linking.openURL(url).catch((error: unknown) => toast.error(`Could not open ${url}: ${errorText(error)}`));
  };
}
