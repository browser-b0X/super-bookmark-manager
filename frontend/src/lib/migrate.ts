import { useEffect } from "react";
import { useLibrary } from "../store/library";
import { startLibraryPersistence, useLibraryPersistence } from "./libraryPersistence";
import { startEnrichmentQueue } from "./metadataEnrichment";

export function useLegacyMigration() {
  const demo = useLibrary(s => s.demo);
  const status = useLibraryPersistence(s => s.status);
  useEffect(() => startLibraryPersistence(), []);
  useEffect(() => startEnrichmentQueue(), []);
  useEffect(() => {
    if (status === "error" && !useLibrary.getState().migrated) useLibrary.getState().seedDemo();
  }, [status]);
  if (demo) return "demo";
  if (status === "saved") return "done";
  if (status === "syncing") return "syncing";
  return "idle";
}
