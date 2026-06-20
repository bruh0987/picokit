import { createApp } from "../../src/main";
import { HomePage, AppPage, AboutPage, AppLayout } from "./components/components";
import { TodoDetailPage } from "./components/TodoDetailPage";

const app = createApp();

const color = {
  blueBold: "\x1b[1;34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  inverseMagenta: "\x1b[7;35m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

const statusColor = (status: number) => {
  if (status >= 400) return color.red;
  if (status >= 300) return color.yellow;
  if (status >= 200) return color.green;
  return color.cyan;
};

app.use(async ({ method, path }, next) => {
  const start = performance.now();
  const response = await next();
  const duration = Math.round(performance.now() - start);

  console.log(
    `${color.cyan}${method}${color.reset} ` +
      `${color.inverseMagenta}${path}${color.reset} ` +
      `${color.blueBold}->${color.reset} ` +
      `${statusColor(response.status)}${response.status}${color.reset} ` +
      `${color.yellow}${duration}ms${color.reset}`,
  );

  return response;
});

app.static("/", HomePage);

app.cluster("/app", (c) => {
  c.layout(AppLayout);
  c.route("/", AppPage);
  c.route("/about", AboutPage);
  c.route("/todos/:id", TodoDetailPage);
});

app.start({ port: 5173 });
