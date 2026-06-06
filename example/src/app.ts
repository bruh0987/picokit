import { createApp } from "../../src/main";
import { HomePage, AppPage } from "./components/components";

const app = createApp();

app.static("/", HomePage);

app.cluster("/app", (c) => {
  c.route("/", AppPage);
});

app.listen(3000);
