import { useBackend, useMutationBackend } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/backend.ts";
import { useRoute } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/router.ts";
import { db } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/client.ts";
import { todos } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/schema.ts";
export const TodoDetailPage = () => {
    const route = useRoute();
    const id = Number(route.params.id);
    const { data, loading, error } = useBackend("todo_detail", undefined, { input: { id } });
    const updateTodo = useMutationBackend<{
        id: number;
        completed: boolean;
    }>("update_todo_detail");
    return (<div>
      <h2>Todo detail</h2>
      <p>
        <a href="/app">Back to todos</a>
      </p>

      {loading ? <p>Loading todo...</p> : null}
      {error ? <p>{error.message}</p> : null}
      {!loading && !data ? <p>Todo not found.</p> : null}

      {data ? (<div>
          <h3>{data.title}</h3>
          <p>Todo id: {route.params.id}</p>
          <p>Status: {data.completed ? "Completed" : "Active"}</p>
          <button onClick={() => updateTodo({ id: data.id, completed: !data.completed })} disabled={updateTodo.loading}>
            {data.completed ? "Mark active" : "Mark complete"}
          </button>
          {updateTodo.error ? <p>{updateTodo.error.message}</p> : null}
        </div>) : null}
    </div>);
};
