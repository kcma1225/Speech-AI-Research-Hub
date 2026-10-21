/**
 * Job handler registrations loaded by the ai-worker process. Modules append ONE import line for the file that
 * calls `registerAiJob(...)` (keep each registration module free of side effects other than registering).
 */
import "../ai/embedding/reindex-job.js";
import "../ai-jobs/library/import-job.js";
import "../ai-jobs/slides/register.js";
import "../lib/search/index-job.js";
import "../ai-jobs/meetings/register.js";
