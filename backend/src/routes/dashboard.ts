import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../lib/auth.js";
import { studyCards } from "../lib/studies/queries.js";
import { TASK_SELECT, type Task } from "../lib/studies/tasks.js";

type ActivityRow = {
  id: string; kind: string; title: string; url: string | null; at: string; metadata: Record<string, unknown>;
  actor: { id: string; name: string } | null; study: { id: string; slug: string; title: string };
};

const dashboard: FastifyPluginAsync = async app => {
  /**
   * v3 overview: the caller's studies, their open tasks (soonest due first), recent activity across every
   * study (everyone may read every study) and counts. Dates compare in Asia/Taipei.
   */
  app.get("/dashboard", async (request, reply) => {
    const user = await requireUser(request);
    const [myStudies, myTasks, activity, counts, pendingDrafts, upcomingMeetings] = await Promise.all([
      studyCards(app.db, user.id, { memberId: user.id, limit: 50 }),
      app.db.query<Task & { study: { id: string; slug: string; title: string } }>(
        `${TASK_SELECT.replace("FROM tasks t", "FROM tasks t JOIN studies st ON st.id=t.study_id").replace(
          "t.created_at,t.updated_at",
          "t.created_at,t.updated_at,json_build_object('id',st.id,'slug',st.slug,'title',st.title) AS study",
        )}
          WHERE t.assignee_id=$1 AND t.status='open' AND st.status<>'archived'
          ORDER BY t.due_on NULLS LAST, t.created_at DESC LIMIT 10`,
        [user.id],
      ),
      app.db.query<ActivityRow>(
        `SELECT a.id::text AS id,a.kind,a.title,a.url,a.created_at AS at,a.metadata,
                CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id',u.id,'name',u.name) END AS actor,
                json_build_object('id',s.id,'slug',s.slug,'title',s.title) AS study
           FROM study_activity a JOIN studies s ON s.id=a.study_id LEFT JOIN users u ON u.id=a.actor_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT 20`,
      ),
      app.db.query<{ my_studies: number; lab_studies: number; open_tasks: number; overdue_tasks: number; due_this_week: number }>(
        `WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Taipei')::date AS d)
         SELECT (SELECT count(*)::int FROM studies s JOIN study_members m ON m.study_id=s.id AND m.user_id=$1 WHERE s.status='active') AS my_studies,
                (SELECT count(*)::int FROM studies WHERE status='active') AS lab_studies,
                (SELECT count(*)::int FROM tasks WHERE assignee_id=$1 AND status='open') AS open_tasks,
                (SELECT count(*)::int FROM tasks, today WHERE assignee_id=$1 AND status='open' AND due_on < today.d) AS overdue_tasks,
                (SELECT count(*)::int FROM tasks, today WHERE assignee_id=$1 AND status='open' AND due_on >= today.d AND due_on < today.d + 7) AS due_this_week`,
        [user.id],
      ),
      // Meeting drafts the caller may confirm: pending drafts of studies they own or are a member of (not advisor).
      app.db.query<{ id: string; meeting: { id: string; title: string; held_at: string }; study: { id: string; slug: string; title: string } }>(
        `SELECT d.id,json_build_object('id',mt.id,'title',mt.title,'held_at',mt.held_at) AS meeting,
                json_build_object('id',s.id,'slug',s.slug,'title',s.title) AS study
           FROM meeting_study_drafts d
           JOIN meetings mt ON mt.id=d.meeting_id
           JOIN studies s ON s.id=d.study_id
           JOIN study_members m ON m.study_id=s.id AND m.user_id=$1 AND m.role IN ('owner','member')
          WHERE d.status='pending'
          ORDER BY mt.held_at DESC, d.id LIMIT 5`,
        [user.id],
      ),
      app.db.query<{ id: string; title: string; held_at: string }>(
        `SELECT mt.id,mt.title,mt.held_at FROM meetings mt
          WHERE mt.held_at >= now() - interval '2 hours'
            AND (mt.created_by=$1 OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id=mt.id AND p.user_id=$1))
          ORDER BY mt.held_at LIMIT 5`,
        [user.id],
      ),
    ]);
    const c = counts.rows[0]!;
    return reply.header("Cache-Control", "no-store").send({
      myStudies,
      myTasks: myTasks.rows,
      activity: activity.rows,
      pendingDrafts: pendingDrafts.rows,
      upcomingMeetings: upcomingMeetings.rows,
      counts: { myStudies: c.my_studies, labStudies: c.lab_studies, openTasks: c.open_tasks, overdueTasks: c.overdue_tasks, dueThisWeek: c.due_this_week },
    });
  });
};

export default dashboard;
