import { randomBytes } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config';
import { closeDatabase, getDatabase } from '../db/database';
import {
  createUserWithRole,
  resetUserPassword,
  UserRole,
  validateRegistrationInput,
} from '../services/auth/users';

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;
const VALID_COMMANDS = new Set(['create-user', 'reset-password']);

interface ParsedArgs {
  command?: string;
  username?: string;
  dbPath?: string;
  role: UserRole;
  roleProvided: boolean;
  random: boolean;
  help: boolean;
  errors: string[];
}

class CliError extends Error {}

export const USER_MAINTENANCE_HELP = `Usage:
  haico create-user <username> [--role admin|member] [--db <path>]
  haico reset-password <username> [--random] [--db <path>]

Commands:
  create-user      Create a user. Defaults to role "member".
  reset-password   Reset an existing user's password.

Options:
  --db <path>      Override the SQLite database path.
  --role <role>    User role for create-user: admin or member.
  --random         Generate and print a random password for reset-password.
  -h, --help       Show this help message.
`;

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: args[0],
    role: 'member',
    roleProvided: false,
    random: false,
    help: false,
    errors: [],
  };

  if (!parsed.command) {
    parsed.errors.push('Missing command.');
    return parsed;
  }

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '--db') {
      const value = args[++i];
      if (!value) parsed.errors.push('Missing value for --db.');
      else parsed.dbPath = value;
      continue;
    }

    if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length);
      if (!value) parsed.errors.push('Missing value for --db.');
      else parsed.dbPath = value;
      continue;
    }

    if (arg === '--role') {
      const value = args[++i];
      if (!value) parsed.errors.push('Missing value for --role.');
      else {
        parsed.role = value as UserRole;
        parsed.roleProvided = true;
      }
      continue;
    }

    if (arg.startsWith('--role=')) {
      const value = arg.slice('--role='.length);
      if (!value) parsed.errors.push('Missing value for --role.');
      else {
        parsed.role = value as UserRole;
        parsed.roleProvided = true;
      }
      continue;
    }

    if (arg === '--random') {
      parsed.random = true;
      continue;
    }

    if (arg.startsWith('--')) {
      parsed.errors.push(`Unknown option: ${arg}`);
      continue;
    }

    if (!parsed.username) {
      parsed.username = arg;
    } else {
      parsed.errors.push(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function validateUsername(username: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return 'Username must be 2-32 characters (letters, numbers, -, _)';
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 4) {
    return 'Password must be at least 4 characters';
  }
  return null;
}

function promptPassword(message: string): Promise<string> {
  const isHidden = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isHidden,
  });

  if (!isHidden) {
    return new Promise((resolve) => {
      rl.question(message, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  const mutableRl = rl as readline.Interface & {
    _writeToOutput?: (stringToWrite: string) => void;
  };
  const originalWriteToOutput = mutableRl._writeToOutput;
  mutableRl._writeToOutput = () => {};

  process.stdout.write(message);
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      if (originalWriteToOutput) mutableRl._writeToOutput = originalWriteToOutput;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function promptPasswordTwice(firstPrompt: string, secondPrompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(firstPrompt);
    const input = await readAllStdin();
    process.stdout.write(secondPrompt);
    const [password = '', confirmation = ''] = input.replace(/\r\n/g, '\n').split('\n');

    const validationError = validatePassword(password);
    if (validationError) throw new CliError(validationError);
    if (password !== confirmation) {
      throw new CliError('Passwords do not match');
    }
    return password;
  }

  const password = await promptPassword(firstPrompt);
  const validationError = validatePassword(password);
  if (validationError) throw new CliError(validationError);

  const confirmation = await promptPassword(secondPrompt);
  if (password !== confirmation) {
    throw new CliError('Passwords do not match');
  }

  return password;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function generateRandomPassword(): string {
  return randomBytes(18).toString('base64url');
}

function resolvedDatabasePath(dbPath?: string): string {
  return path.resolve(dbPath || config.dbPath);
}

function printErrors(errors: string[]): void {
  for (const error of errors) {
    console.error(`Error: ${error}`);
  }
}

export async function runUserMaintenanceCommand(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    console.log(USER_MAINTENANCE_HELP);
    return 0;
  }

  if (!parsed.command || !VALID_COMMANDS.has(parsed.command)) {
    printErrors(parsed.errors.length > 0 ? parsed.errors : [`Unknown command: ${parsed.command || ''}`]);
    console.error(USER_MAINTENANCE_HELP);
    return 1;
  }

  if (!parsed.username) {
    parsed.errors.push('Missing username.');
  } else {
    const usernameError = validateUsername(parsed.username);
    if (usernameError) parsed.errors.push(usernameError);
  }

  if (!['admin', 'member'].includes(parsed.role)) {
    parsed.errors.push('Invalid role. Expected "admin" or "member".');
  }

  if (parsed.command === 'create-user' && parsed.random) {
    parsed.errors.push('--random is only supported by reset-password.');
  }

  if (parsed.command === 'reset-password' && parsed.roleProvided) {
    parsed.errors.push('--role is only supported by create-user.');
  }

  if (parsed.errors.length > 0) {
    printErrors(parsed.errors);
    return 1;
  }

  const username = parsed.username!;
  const dbPath = resolvedDatabasePath(parsed.dbPath);

  try {
    const db = getDatabase(parsed.dbPath, { skipStartupMaintenance: true });

    if (parsed.command === 'create-user') {
      const password = await promptPasswordTwice('Password: ', 'Confirm password: ');
      const validationError = validateRegistrationInput({ username, password });
      if (validationError) throw new CliError(validationError);

      const user = createUserWithRole(db, username, password, parsed.role);
      if (user === 'duplicate') {
        throw new CliError(`User "${username}" already exists`);
      }

      console.log(`Created ${user.role} user "${user.username}" in ${dbPath}`);
      return 0;
    }

    const password = parsed.random
      ? generateRandomPassword()
      : await promptPasswordTwice('New password: ', 'Confirm new password: ');
    const passwordError = validatePassword(password);
    if (passwordError) throw new CliError(passwordError);

    const user = resetUserPassword(db, username, password);
    if (!user) {
      throw new CliError(`User "${username}" not found`);
    }

    if (parsed.random) {
      console.log(`Generated password for ${username}: ${password}`);
    }
    console.log(`Reset password for user "${username}" in ${dbPath}`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  runUserMaintenanceCommand().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    process.exitCode = 1;
  });
}
