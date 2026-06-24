import { useBackend, useMutationBackend } from "../../../src/backend";
import { useRoute } from "../../../src/router";
import { eq } from "drizzle-orm";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { db } from "../db/client";
import { todos } from "../db/schema";

export const AppLayout = ({ children }: { children: ReactNode }) => {
  const { pathname } = useRoute();
  // Lives in the layout, so it survives navigation between cluster routes.
  const [count, setCount] = useState(0);

  // pathname here is the cluster-nested path ("/", "/about"), not the full "/app/...".
  const link = (nested: string, label: string) => (
    <a
      href={`/app${nested === "/" ? "" : nested}`}
      style={{
        fontWeight: pathname === nested ? "bold" : "normal",
        marginRight: 12,
      }}
    >
      {label}
    </a>
  );

  return (
    <div>
      <nav
        style={{
          borderBottom: "1px solid #ccc",
          paddingBottom: 8,
          marginBottom: 16,
        }}
      >
        {link("/", "Todos")}
        {link("/about", "About")}
        <button
          onClick={() => setCount((value) => value + 1)}
          style={{ float: "right" }}
        >
          layout state: {count}
        </button>
      </nav>
      {children}
    </div>
  );
};

export const HomePage = () => {
  return (
    <div>
      <img src="/static/logo.svg" alt="picokit logo" width={64} height={64} />
      <h1>Todo app</h1>

      <p>
        Static home page for that juicy <i>SEO</i> btw
      </p>
      <a href="/app">Start Now</a>
    </div>
  );
};

export const AboutPage = () => {
  return (
    <div>
      <h2>About</h2>
      <p>
        A tiny todo app built with picokit. Notice the nav-click counter
        persists.
      </p>
    </div>
  );
};

export const AppPage = () => {
  const [title, setTitle] = useState("");
  const { data, loading, error, refetch } = useBackend(
    "all_todos",
    async () => {
      return db.select().from(todos).all();
    },
  );

  const createTodo = useMutationBackend<{ title: string }>(
    "create_todo",
    async ({ input }) => {
      const [todo] = await db
        .insert(todos)
        .values({ title: input.title.trim() })
        .returning();

      return todo;
    },
  );

  const updateTodo = useMutationBackend<{ id: number; completed: boolean }>(
    "update_todo",
    async ({ input }) => {
      const [todo] = await db
        .update(todos)
        .set({ completed: input.completed })
        .where(eq(todos.id, input.id))
        .returning();

      return todo;
    },
  );

  const deleteTodo = useMutationBackend<{ id: number }>(
    "delete_todo",
    async ({ input }) => {
      const [todo] = await db
        .delete(todos)
        .where(eq(todos.id, input.id))
        .returning();

      return todo;
    },
  );

  const activeTodos = data?.filter((todo) => !todo.completed).length ?? 0;
  const completedTodos = data?.filter((todo) => todo.completed).length ?? 0;

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    await createTodo({ title: trimmedTitle });
    setTitle("");
    await refetch();
  };

  return (
    <div>
      <h2>Todo list</h2>
      <form onSubmit={onCreate}>
        <input
          value={title}
          placeholder="New todo"
          onChange={(event) =>
            setTitle((event.target as unknown as { value: string }).value)
          }
        />
        <button disabled={!title.trim() || createTodo.loading}>
          {createTodo.loading ? "Adding..." : "Add todo"}
        </button>
      </form>

      <p>
        {activeTodos} active, {completedTodos} completed
      </p>

      {loading ? <p>Loading todos...</p> : null}
      {error ? <p>{error.message}</p> : null}
      {createTodo.error ? <p>{createTodo.error.message}</p> : null}
      {deleteTodo.error ? <p>{deleteTodo.error.message}</p> : null}
      {data?.length === 0 ? <p>No todos yet.</p> : null}
      <ul>
        {data?.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() =>
                  updateTodo({ id: todo.id, completed: !todo.completed }).then(
                    refetch,
                  )
                }
              />
              {todo.title}
            </label>{" "}
            <a href={`/app/todos/${todo.id}`}>Open</a>{" "}
            <button
              onClick={() => deleteTodo({ id: todo.id }).then(refetch)}
              disabled={deleteTodo.loading}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {updateTodo.loading ? <p>Saving...</p> : null}
      {updateTodo.error ? <p>{updateTodo.error.message}</p> : null}
    </div>
  );
};
