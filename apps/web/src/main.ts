import { createApp } from 'vue';
import { createPinia } from 'pinia';
import {
  Button,
  Cell,
  CellGroup,
  Collapse,
  CollapseItem,
  Field,
  NavBar,
  NoticeBar,
  Popup,
  Radio,
  RadioGroup,
  Switch,
  Tabbar,
  TabbarItem,
  Tag,
} from 'vant';
import 'vant/lib/index.css';
import './styles/app.css';

import App from './App.vue';
import { router } from './router';

const app = createApp(App);

app.use(createPinia());
app.use(router);

// Register Vant components explicitly
app
  .use(Button)
  .use(Cell)
  .use(CellGroup)
  .use(Collapse)
  .use(CollapseItem)
  .use(Field)
  .use(NavBar)
  .use(NoticeBar)
  .use(Popup)
  .use(Radio)
  .use(RadioGroup)
  .use(Switch)
  .use(Tabbar)
  .use(TabbarItem)
  .use(Tag);

app.mount('#app');
