import { Slots4 } from "../../base/slots.ts";
import { Slots8 } from "../../base/slots.ts";
// Constants of the keys of members, properties, object pattern properties and enum members (decl.ts). A leaf module: no imports.

export const KEY_NONE: number = -1;
export const KEY_IDENT: number = 0;
export const KEY_STRING: number = 1;
export const KEY_NUMBER: number = 2;
export const KEY_PRIVATE: number = 3;
export const KEY_COMPUTED_STRING: number = 4;
export const KEY_COMPUTED_NUMBER: number = 5;
export const KEY_COMPUTED: number = 6;

/** Slots of `keyLoad`. */
export const KEY = new Slots8();
export const KEY_KIND: number = 0;
export const KEY_NAME: number = 1;
export const KEY_EXPR: number = 2;
export const KEY_START: number = 3;
export const KEY_JSX: number = 4;

/** Result slots of `tupleElemFlowVarianceAndLabel`: the label's atom and position. */
export const FLOW = new Slots4();
export const FLOW_LABEL_ATOM: number = 0;
export const FLOW_LABEL_POS: number = 1;

