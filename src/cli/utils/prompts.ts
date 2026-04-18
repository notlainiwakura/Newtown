/**
 * Interactive prompts for CLI commands
 */

import inquirer from 'inquirer';
import chalk from 'chalk';

export interface OnboardAnswers {
  confirmSetup: boolean;
  generateToken: boolean;
}

export interface ApiKeyAnswers {
  hasApiKey: boolean;
  apiKeyEnvVar?: string;
}

/**
 * Display welcome banner
 */
export function displayBanner(): void {
  console.log(chalk.cyan(`
  ██╗      █████╗ ██╗███╗   ██╗
  ██║     ██╔══██╗██║████╗  ██║
  ██║     ███████║██║██╔██╗ ██║
  ██║     ██╔══██║██║██║╚██╗██║
  ███████╗██║  ██║██║██║ ╚████║
  ╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
  `));
  console.log(chalk.dim('  ...present day, present time\n'));
}

/**
 * Prompt for onboarding confirmation
 */
export async function promptOnboard(): Promise<OnboardAnswers> {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmSetup',
      message: 'Initialize Lain in ~/.lain?',
      default: true,
    },
    {
      type: 'confirm',
      name: 'generateToken',
      message: 'Generate authentication token?',
      default: true,
      when: (answers) => answers.confirmSetup,
    },
  ]);
}

/**
 * Prompt for API key configuration
 */
export async function promptApiKey(): Promise<ApiKeyAnswers> {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'hasApiKey',
      message: 'Do you have an Anthropic API key?',
      default: false,
    },
    {
      type: 'input',
      name: 'apiKeyEnvVar',
      message: 'Environment variable name for API key:',
      default: 'ANTHROPIC_API_KEY',
      when: (answers) => answers.hasApiKey,
    },
  ]);
}

/**
 * Display success message
 */
export function displaySuccess(message: string): void {
  console.log(chalk.green('✓'), message);
}

/**
 * Display error message
 */
export function displayError(message: string): void {
  console.log(chalk.red('✗'), message);
}

/**
 * Display warning message
 */
export function displayWarning(message: string): void {
  console.log(chalk.yellow('!'), message);
}

/**
 * Display info message
 */
export function displayInfo(message: string): void {
  console.log(chalk.blue('i'), message);
}

/**
 * Display a status item
 */
export function displayStatus(label: string, value: string, ok: boolean = true): void {
  const icon = ok ? chalk.green('●') : chalk.red('●');
  console.log(`  ${icon} ${chalk.dim(label + ':')} ${value}`);
}

/**
 * Display a section header
 */
export function displaySection(title: string): void {
  console.log(chalk.bold(`\n${title}`));
  console.log(chalk.dim('─'.repeat(40)));
}

/**
 * Prompt for confirmation
 */
export async function confirm(message: string, defaultValue: boolean = false): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: defaultValue,
    },
  ]);
  return confirmed;
}

/**
 * Display spinner-like waiting message
 */
export function displayWaiting(message: string): void {
  console.log(chalk.dim('...'), message);
}
