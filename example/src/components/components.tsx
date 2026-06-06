import { useBackend, useMutationBackend } from "../../../src/backend";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { todos } from "../db/schema";

export const HomePage = () => {
  return (
    <div>
      <h1>Todo app</h1>

      <p>
        Static home page for that juicy <i>SEO</i> btw
      </p>
      <a href="/app">Start Now</a>
    </div>
  );
};

export const AppPage = () => {
  const { data, loading, error } = useBackend("all_todos", async () => {
    return db.select().from(todos).all();
  });

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

  return (
    <div>
      <h2>Todo list</h2>
      {loading ? <p>Loading todos...</p> : null}
      {error ? <p>{error.message}</p> : null}
      {data?.length === 0 ? <p>No todos yet.</p> : null}
      <ul>
        {data?.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() =>
                  updateTodo({ id: todo.id, completed: !todo.completed })
                }
              />
              {todo.title}
            </label>
          </li>
        ))}
      </ul>
      {updateTodo.loading ? <p>Saving...</p> : null}
      {updateTodo.error ? <p>{updateTodo.error.message}</p> : null}
    </div>
  );
};
