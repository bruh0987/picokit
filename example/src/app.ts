import { createApp } from "../../src/main";
import { HomePage, AppPage } from "./components/components";
import { TodoDetailPage } from "./components/TodoDetailPage";

const app = createApp();

app.static("/", HomePage);

app.cluster("/app", (c) => {
  c.route("/", AppPage);
  c.route("/todos/:id", TodoDetailPage);
});

app.listen(3000);
