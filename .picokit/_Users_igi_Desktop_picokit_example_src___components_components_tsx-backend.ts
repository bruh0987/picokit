import { useBackend, useMutationBackend } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/backend.ts";
import { eq } from "drizzle-orm";
import { useState } from "react";
import type { FormEvent } from "react";
import { db } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/client.ts";
import { todos } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/schema.ts";
import type { BackendRuntimeHandler } from "../src/backend";

export const handlers: BackendRuntimeHandler[] = [];

const handler0 = async () => {
      return db.select().from(todos).all();
    };
handlers.push({ id: "all_todos", handler: handler0 });

const handler1 = async ({ input }) => {
      const [todo] = await db
        .insert(todos)
        .values({ title: input.title.trim() })
        .returning();

      return todo;
    };
handlers.push({ id: "create_todo", handler: handler1 });

const handler2 = async ({ input }) => {
      const [todo] = await db
        .update(todos)
        .set({ completed: input.completed })
        .where(eq(todos.id, input.id))
        .returning();

      return todo;
    };
handlers.push({ id: "update_todo", handler: handler2 });

const handler3 = async ({ input }) => {
      const [todo] = await db
        .delete(todos)
        .where(eq(todos.id, input.id))
        .returning();

      return todo;
    };
handlers.push({ id: "delete_todo", handler: handler3 });
