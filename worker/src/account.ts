// Huella corta de una cuenta del proveedor: identifica sus datos (vencimiento, conexiones) en health/<cfgId>.json sin
// guardar usuario ni contraseña. Se mantiene el prefijo "grilla-link" para que las huellas ya guardadas sigan valiendo.
import { sha256Hex } from './crypto.ts';

export const ACCOUNT_KEY_LEN = 12;
export const accountKey = async (username: string, password: string) =>
  (await sha256Hex(`grilla-link\n${username}\n${password}`)).slice(0, ACCOUNT_KEY_LEN);
