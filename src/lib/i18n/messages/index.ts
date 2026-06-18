// The registry of every translation namespace. Add a new feature's strings by
// creating `messages/<ns>.ts` (see types.ts for the shape) and registering it
// here. The provider looks strings up as MESSAGES[namespace][locale][key].

import { automation } from "./automation";
import { board } from "./board";
import { chat } from "./chat";
import { commandPalette } from "./commandPalette";
import { common } from "./common";
import { meeting } from "./meeting";
import { quick } from "./quick";
import { screen } from "./screen";
import { settings } from "./settings";
import { sidebar } from "./sidebar";

export const MESSAGES = {
  common,
  settings,
  sidebar,
  chat,
  commandPalette,
  board,
  automation,
  screen,
  quick,
  meeting,
};

export type Namespace = keyof typeof MESSAGES;
