#!/usr/bin/env node
// Creates the two values the admin panel needs. Run: npm run admin:password
// The password is typed without echo and never stored; only its PBKDF2 hash is printed.
import crypto from 'node:crypto';
import readline from 'node:readline';
import { hashPassword } from '../worker/admin.js';

function ask(question) {
  if (process.argv[2]) return Promise.resolve(process.argv[2]); // non-interactive use (avoid: stays in shell history)
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = await ask('Contraseña nueva para el panel (mínimo 10 caracteres): ');
if (password.length < 10) { console.error('Tiene que tener al menos 10 caracteres.'); process.exit(1); }
const again = process.argv[2] ? password : await ask('Repítela: ');
if (again !== password) { console.error('No coinciden.'); process.exit(1); }

const iterations = process.env.ADMIN_HASH_ITERATIONS ? Number(process.env.ADMIN_HASH_ITERATIONS) : 600000;
console.log('\nCargá estas dos variables en Vercel (Settings → Environment Variables), marcadas como "Sensitive":\n');
console.log('ADMIN_PASSWORD_HASH=' + await hashPassword(password, iterations));
console.log('ADMIN_SESSION_SECRET=' + crypto.randomBytes(32).toString('base64url'));
console.log('\nPara cambiar la contraseña más adelante, repetí este comando y reemplazá ADMIN_PASSWORD_HASH (cierra las sesiones abiertas).');
