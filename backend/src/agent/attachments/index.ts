/** Assistant attachments (docs/architecture.md "Agent → Attachments"). Importing registers `read_attachment`. */
import "./tool.js";

export * from "./types.js";
export { prepareAttachments, describeRef, buildAttachmentBlocks, KIND_ZH, type PreparedAttachments } from "./resolve.js";
export { inlineAttachmentImages } from "./images.js";
export { storeUpload, uploadView, ownUpload, UPLOAD_ACCEPT, UPLOAD_MAX_BYTES, UPLOAD_IMAGE_MAX_BYTES, type UploadRow } from "./uploads.js";
