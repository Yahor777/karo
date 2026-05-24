/**
 * Public surface of the File_Artifact viewer screen module (task 10.3).
 *
 * Validates: Requirements 11.4, 11.5, 11.7.
 */

export type {
  ArtifactGateway,
  DiffPatch,
  FileArtifactContent,
  FileArtifactMetadata,
  TaskId,
} from "../../ports/artifacts.js";

export type {
  ArtifactViewerController,
  ArtifactViewerControllerOptions,
  ArtifactViewerListener,
  ArtifactViewerState,
  ContentStatus,
  DiffStatus,
  ListStatus,
} from "./artifactViewerController.js";
export { createArtifactViewerController } from "./artifactViewerController.js";

export type { MountArtifactViewerOptions } from "./mountArtifactViewer.js";
export { mountArtifactViewer } from "./mountArtifactViewer.js";
