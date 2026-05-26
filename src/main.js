import { createApp } from "vue";
import { createPinia } from "pinia";
import sClick from "./directives/sclick";
import App from "./App.vue";
import "./styles/css/global.css";
import "./styles/scss/global.scss";
import "./styles/scss/theme.nt.scss";
import "./styles/scss/theme.glass.scss";

const app = createApp(App);
app.use(createPinia());
app.directive("sclick", sClick);
app.mount("#app");
