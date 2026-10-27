import { hash } from '@node-rs/argon2';
import { migrate, openDatabase } from '../db/database.js';
import { createUser, findUserByEmail, setUserPassword } from '../db/repos/users.js';
import { randomToken } from '../lib/crypto.js';

// Uso: node dist/cli/users.js create <email>   |   node dist/cli/users.js reset-password <email>
// Gera uma senha forte aleatória e a mostra UMA vez (não há tela de cadastro, por segurança).

const [command, email] = process.argv.slice(2);
if (!command || !email || !['create', 'reset-password'].includes(command) || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Uso: users <create|reset-password> <email>');
  process.exit(1);
}

const db = openDatabase(process.env.DATABASE_PATH ?? './data/app.db');
migrate(db);
const password = randomToken(12);
const passwordHash = await hash(password);

if (command === 'create') {
  if (findUserByEmail(db, email)) {
    console.error('Já existe um usuário com este e-mail. Use reset-password.');
    process.exit(1);
  }
  createUser(db, email, passwordHash, Date.now());
} else if (!setUserPassword(db, email, passwordHash)) {
  console.error('Usuário não encontrado.');
  process.exit(1);
}

console.log(`Usuário: ${email.toLowerCase()}\nSenha:   ${password}\nGuarde a senha agora — ela não será exibida de novo.`);
db.close();
