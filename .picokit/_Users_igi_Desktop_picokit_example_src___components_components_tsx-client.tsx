import { useBackend, useMutationBackend } from "C:/Users/igi/Desktop/picokit/example/src/./components/../../../src/backend.ts";
import { useState } from "react";
import type { FormEvent } from "react";
import { db } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/client.ts";
import { todos } from "C:/Users/igi/Desktop/picokit/example/src/./components/../db/schema.ts";
export const HomePage = () => {
    return (<div>
      <h1>Todo app</h1>

      <p>
        Static home page for that juicy <i>SEO</i> btw
      </p>
      <a href="/app">Start Now</a>
    </div>);
};
export const AppPage = () => {
    const [title, setTitle] = useState("");
    const [refreshKey, setRefreshKey] = useState(0);
    const { data, loading, error } = useBackend("all_todos", undefined, { input: { refreshKey } });
    const refreshTodos = () => setRefreshKey((key) => key + 1);
    const createTodo = useMutationBackend<{
        title: string;
    }>("create_todo");
    const updateTodo = useMutationBackend<{
        id: number;
        completed: boolean;
    }>("update_todo");
    const deleteTodo = useMutationBackend<{
        id: number;
    }>("delete_todo");
    const activeTodos = data?.filter((todo) => !todo.completed).length ?? 0;
    const completedTodos = data?.filter((todo) => todo.completed).length ?? 0;
    const onCreate = async (event: FormEvent) => {
        event.preventDefault();
        const trimmedTitle = title.trim();
        if (!trimmedTitle)
            return;
        await createTodo({ title: trimmedTitle });
        setTitle("");
        refreshTodos();
    };
    return (<div>
      <h2>Todo list</h2>
      <form onSubmit={onCreate}>
        <input value={title} placeholder="New todo" onChange={(event) => setTitle((event.target as unknown as {
            value: string;
        }).value)}/>
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
        {data?.map((todo) => (<li key={todo.id}>
            <label>
              <input type="checkbox" checked={todo.completed} onChange={() => updateTodo({ id: todo.id, completed: !todo.completed }).then(refreshTodos)}/>
              {todo.title}
            </label>
            {" "}
            <a href={`/app/todos/${todo.id}`}>Open</a>
            {" "}
            <button onClick={() => deleteTodo({ id: todo.id }).then(refreshTodos)} disabled={deleteTodo.loading}>
              Delete
            </button>
          </li>))}
      </ul>
      {updateTodo.loading ? <p>Saving...</p> : null}
      {updateTodo.error ? <p>{updateTodo.error.message}</p> : null}
    </div>);
};
