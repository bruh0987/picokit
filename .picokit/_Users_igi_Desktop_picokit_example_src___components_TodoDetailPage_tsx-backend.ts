import { useBackend, useMutationBackend } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/backend.ts";
import { useRoute } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/router.ts";
import { eq } from "drizzle-orm";
import { db } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/client.ts";
import { todos } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/schema.ts";
import type { BackendRuntimeHandler } from "../src/backend";

export const handlers: BackendRuntimeHandler[] = [];

const handler0 = async ({ input }) => {
      const [todo] = await db
        .select()
        .from(todos)
        .where(eq(todos.id, input.id));

      return todo;
    };
handlers.push({ id: "todo_detail", handler: handler0 });

const handler1 = async ({ input }) => {
      const [todo] = await db
        .update(todos)
        .set({ completed: input.completed })
        .where(eq(todos.id, input.id))
        .returning();

      return todo;
    };
handlers.push({ id: "update_todo_detail", handler: handler1 });
