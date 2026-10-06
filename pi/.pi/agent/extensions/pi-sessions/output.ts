import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const Action = StringEnum([
  "create", "list", "recall", "status", "read", "send", "report", "watch", "focus", "stop", "resume", "rename",
] as const);
export type ActionName = Static<typeof Action>;

const Session = Type.Object({
  id: Type.String(),
  name: Type.String(),
  sessionPath: Type.String(),
  sessionId: Type.String(),
  cwd: Type.String(),
  createdAt: Type.Number({ description: "Unix milliseconds" }),
  updatedAt: Type.Number({ description: "Unix milliseconds" }),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  lifecycle: StringEnum(["persistent", "task"] as const),
  origin: StringEnum(["created", "discovered", "historical"] as const),
  orchestrated: Type.Boolean(),
  parentSessionId: Type.Optional(Type.String()),
});
const Pane = Type.Object({
  pane_id: Type.String(),
  agent: Type.Optional(Type.String()),
  agent_status: Type.Optional(Type.String()),
  workspace_id: Type.Optional(Type.String()),
  tab_id: Type.Optional(Type.String()),
  agent_session: Type.Optional(Type.Union([Type.Object({
    kind: Type.Optional(Type.String()), value: Type.Optional(Type.String()),
  }), Type.Null()])),
});
const Message = Type.Object({
  id: Type.String(),
  role: StringEnum(["user", "assistant", "report", "summary"] as const),
  text: Type.String(),
  timestamp: Type.Number({ description: "Unix milliseconds" }),
  stopReason: Type.Optional(Type.String()),
});
const Delivery = Type.Object({
  messageId: Type.String(),
  state: StringEnum(["queued", "accepted", "unknown", "rejected"] as const),
  entryId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
const ListedSession = Type.Object({
  ...Session.properties,
  status: Type.String(),
  runtimes: Type.Array(Pane),
  startingMessageAccepted: Type.Boolean(),
});
const RecallHit = Type.Object({
  session: Session,
  score: Type.Number(),
  matchedTerms: Type.Array(Type.String()),
  lastActivity: Type.Number(),
  evidence: Type.Array(Type.Object({
    entryId: Type.String(), role: Message.properties.role, timestamp: Type.Number(), excerpt: Type.String(),
  })),
});

// A common envelope keeps scripts simple; optional fields depend on the action.
// Delivery acceptance and settled-run outcome deliberately remain separate.
export const SessionOutput = Type.Object({
  action: Action,
  output: Type.String({ description: "The same bounded readable output shown to the model" }),
  truncated: Type.Boolean({ description: "Whether the readable output was truncated; use pagination for full data" }),
  session: Type.Optional(Session),
  sessions: Type.Optional(Type.Array(ListedSession)),
  hits: Type.Optional(Type.Array(RecallHit)),
  messages: Type.Optional(Type.Array(Type.Object({
    ...Message.properties,
    offset: Type.Integer({ minimum: 0, description: "Character offset of this slice in the original message" }),
  }))),
  total: Type.Optional(Type.Integer()),
  scanned: Type.Optional(Type.Integer()),
  limit: Type.Optional(Type.Integer()),
  offset: Type.Optional(Type.Integer()),
  nextOffset: Type.Optional(Type.Integer()),
  nextCursor: Type.Optional(Type.String()),
  queryTerms: Type.Optional(Type.Array(Type.String())),
  after: Type.Optional(Type.Number()),
  before: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String({ description: "Session/runtime status, not proof that a run completed" })),
  runtime: Type.Optional(Type.Union([Pane, Type.Null(), Type.String()], {
    description: "Runtime status string for status; pane or null for runtime-management actions",
  })),
  runtimes: Type.Optional(Type.Array(Pane)),
  stoppedRuntimes: Type.Optional(Type.Array(Pane)),
  latest: Type.Optional(Message),
  runId: Type.Optional(Type.String({ description: "User entry identifying the observed run" })),
  outcome: Type.Optional(StringEnum(["completed", "failed", "aborted", "superseded"] as const)),
  delivery: Type.Optional(Delivery),
  messageId: Type.Optional(Type.String()),
  messageAccepted: Type.Optional(Type.Boolean()),
  startingMessageAccepted: Type.Optional(Type.Boolean()),
  recovered: Type.Optional(Type.Boolean()),
  timedOut: Type.Optional(Type.Boolean()),
  elapsedSeconds: Type.Optional(Type.Number()),
  cleanedUp: Type.Optional(Type.Boolean()),
  cleanupError: Type.Optional(Type.String()),
});
export type SessionResultDetails = Omit<Static<typeof SessionOutput>, "action" | "output" | "truncated">;
