// Spike storage for the room-is-data / turn-is-a-child-run experiment
// (CL-6323 Phase 0). A room is rows: one room row, one row per message,
// one row per turn. Nothing here touches the chat schema, the chat
// migration ledger, or the platform mailbox, so the whole spike is
// removable with one `git rm` of this directory.
//
// The DDL is raw and idempotent on purpose: a spike must not add a
// migration to a ledger that production replays.

import postgres from "postgres";

export type SpikeRoom = {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly runId: string | null;
  readonly address: string | null;
  readonly sessionId: string | null;
};

export type SpikeMessage = {
  readonly id: string;
  readonly roomId: string;
  readonly authorKind: "user" | "agent";
  readonly authorId: string;
  readonly body: string;
  readonly runId: string | null;
  readonly createdAt: string;
};

export type SpikeTurnStatus = "running" | "completed" | "failed";

export type SpikeRoomStore = {
  createRoom(room: {
    id: string;
    tenantId: string;
    name: string;
    systemPrompt: string;
  }): Promise<SpikeRoom>;
  getRoom(roomId: string): Promise<SpikeRoom | undefined>;
  attachRun(
    roomId: string,
    run: { runId: string; address: string; sessionId: string },
  ): Promise<void>;
  insertMessage(message: {
    id: string;
    roomId: string;
    tenantId: string;
    authorKind: "user" | "agent";
    authorId: string;
    body: string;
    runId: string | null;
  }): Promise<SpikeMessage>;
  listMessages(roomId: string, limit?: number): Promise<SpikeMessage[]>;
  insertTurn(turn: {
    id: string;
    roomId: string;
    tenantId: string;
    requestMessageId: string;
    childRunId: string;
  }): Promise<void>;
  finishTurn(turn: {
    id: string;
    status: SpikeTurnStatus;
    replyMessageId: string | null;
  }): Promise<void>;
  getTurn(turnId: string): Promise<
    | {
        readonly id: string;
        readonly roomId: string;
        readonly status: SpikeTurnStatus;
        readonly childRunId: string | null;
        readonly replyMessageId: string | null;
      }
    | undefined
  >;
  close(): Promise<void>;
};

const DDL = [
  `create table if not exists chat.spike_room (
     id text primary key,
     tenant_id text not null,
     name text not null,
     system_prompt text not null,
     run_id text,
     address text,
     session_id text,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists chat.spike_room_message (
     id text primary key,
     room_id text not null,
     tenant_id text not null,
     author_kind text not null,
     author_id text not null,
     body text not null,
     run_id text,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists spike_room_message_room_created_idx
     on chat.spike_room_message (room_id, created_at)`,
  `create table if not exists chat.spike_room_turn (
     id text primary key,
     room_id text not null,
     tenant_id text not null,
     status text not null,
     request_message_id text not null,
     reply_message_id text,
     child_run_id text,
     started_at timestamptz not null default now(),
     ended_at timestamptz
   )`,
];

/**
 * Creates the spike tables if they are absent. Called once at mount
 * time, behind the same env flag that mounts the routes.
 */
export async function ensureSpikeTables(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`create schema if not exists chat`);
    for (const statement of DDL) await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

export function createSpikeRoomStore(databaseUrl: string): SpikeRoomStore {
  const sql = postgres(databaseUrl, { max: 4 });

  return {
    async createRoom(room) {
      await sql`insert into chat.spike_room ${sql({
        id: room.id,
        tenant_id: room.tenantId,
        name: room.name,
        system_prompt: room.systemPrompt,
      })}`;
      return {
        id: room.id,
        tenantId: room.tenantId,
        name: room.name,
        systemPrompt: room.systemPrompt,
        runId: null,
        address: null,
        sessionId: null,
      };
    },

    async getRoom(roomId) {
      const rows = await sql`select id, tenant_id, name, system_prompt, run_id,
                                    address, session_id
                             from chat.spike_room where id = ${roomId}`;
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        id: String(row["id"]),
        tenantId: String(row["tenant_id"]),
        name: String(row["name"]),
        systemPrompt: String(row["system_prompt"]),
        runId: row["run_id"] === null ? null : String(row["run_id"]),
        address: row["address"] === null ? null : String(row["address"]),
        sessionId: row["session_id"] === null ? null : String(row["session_id"]),
      };
    },

    async attachRun(roomId, run) {
      await sql`update chat.spike_room
                set run_id = ${run.runId},
                    address = ${run.address},
                    session_id = ${run.sessionId}
                where id = ${roomId}`;
    },

    async insertMessage(message) {
      const rows = await sql`insert into chat.spike_room_message ${sql({
        id: message.id,
        room_id: message.roomId,
        tenant_id: message.tenantId,
        author_kind: message.authorKind,
        author_id: message.authorId,
        body: message.body,
        run_id: message.runId,
      })} returning created_at`;
      return {
        id: message.id,
        roomId: message.roomId,
        authorKind: message.authorKind,
        authorId: message.authorId,
        body: message.body,
        runId: message.runId,
        createdAt: new Date(String(rows[0]?.["created_at"])).toISOString(),
      };
    },

    async listMessages(roomId, limit = 200) {
      const rows = await sql`select id, room_id, author_kind, author_id, body,
                                    run_id, created_at
                             from chat.spike_room_message
                             where room_id = ${roomId}
                             order by created_at asc
                             limit ${limit}`;
      return rows.map((row) => ({
        id: String(row["id"]),
        roomId: String(row["room_id"]),
        authorKind: row["author_kind"] === "agent" ? "agent" : "user",
        authorId: String(row["author_id"]),
        body: String(row["body"]),
        runId: row["run_id"] === null ? null : String(row["run_id"]),
        createdAt: new Date(String(row["created_at"])).toISOString(),
      }));
    },

    async insertTurn(turn) {
      await sql`insert into chat.spike_room_turn ${sql({
        id: turn.id,
        room_id: turn.roomId,
        tenant_id: turn.tenantId,
        status: "running",
        request_message_id: turn.requestMessageId,
        child_run_id: turn.childRunId,
      })}`;
    },

    async finishTurn(turn) {
      await sql`update chat.spike_room_turn
                set status = ${turn.status},
                    reply_message_id = ${turn.replyMessageId},
                    ended_at = now()
                where id = ${turn.id}`;
    },

    async getTurn(turnId) {
      const rows = await sql`select id, room_id, status, child_run_id,
                                    reply_message_id
                             from chat.spike_room_turn where id = ${turnId}`;
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        id: String(row["id"]),
        roomId: String(row["room_id"]),
        status: row["status"] as SpikeTurnStatus,
        childRunId:
          row["child_run_id"] === null ? null : String(row["child_run_id"]),
        replyMessageId:
          row["reply_message_id"] === null
            ? null
            : String(row["reply_message_id"]),
      };
    },

    async close() {
      await sql.end();
    },
  };
}
