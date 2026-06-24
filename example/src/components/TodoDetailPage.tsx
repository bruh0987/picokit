import { useBackend, useMutationBackend } from "../../../src/backend";
import { useRoute } from "../../../src/router";
import { Head } from "../../../src/head";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { todos } from "../db/schema";

export const TodoDetailPage = () => {
  const route = useRoute();
  const id = Number(route.params.id);
  const { data, loading, error, refetch } = useBackend(
    "todo_detail",
    async ({ input }) => {
      const [todo] = await db
        .select()
        .from(todos)
        .where(eq(todos.id, input.id));

      return todo;
    },
    { input: { id } },
  );

  const updateTodo = useMutationBackend<{ id: number; completed: boolean }>(
    "update_todo_detail",
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
      <Head
        title={data ? `${data.title} · picokit` : `Todo #${route.params.id} · picokit`}
      />
      <h2>Todo detail</h2>
      <p>
        <button onClick={() => route.navigate("/app")}>Back to todos</button>
      </p>

      {loading ? <p>Loading todo...</p> : null}
      {error ? <p>{error.message}</p> : null}
      {!loading && !data ? <p>Todo not found.</p> : null}

      {data ? (
        <div>
          <h3>{data.title}</h3>
          <p>Todo id: {route.params.id}</p>
          <p>Status: {data.completed ? "Completed" : "Active"}</p>
          <button
            onClick={() =>
              updateTodo({ id: data.id, completed: !data.completed })
                .then(refetch)
            }
            disabled={updateTodo.loading}
          >
            {data.completed ? "Mark active" : "Mark complete"}
          </button>
          {updateTodo.error ? <p>{updateTodo.error.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
};
