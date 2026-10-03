/**
 * Differential harness against the frozen Python oracle.
 *
 * The oracle is `dsh-whalechan/.dsh/skills/**`: the same Python the plugin is
 * replacing, pinned and unmodified. It is the only honest source of truth for
 * behaviour that must not drift — a port is correct exactly when it agrees with
 * it, not when its own tests pass.
 *
 * Everything here skips cleanly when the oracle or its interpreter is absent, so
 * the plugin's suite stays runnable on a machine that has neither.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The plugin repository root, derived from this file's location. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** Where the frozen oracle for the character half lives. */
export const CHARACTER_ORACLE = resolve(
  REPO_ROOT,
  '..',
  'dsh-whalechan',
  '.dsh',
  'skills',
  'whalechan-image-character',
)

/** The Pillow `magick` stand-in, which the oracle needs and DSH does not ship. */
export const MAGICK_SHIM = join(REPO_ROOT, 'tools', 'magick-shim')

/** The `manage-run.py` this half is ported from. */
export function oracleScript(leaf: string): string {
  return join(CHARACTER_ORACLE, 'scripts', leaf)
}

/** The bundled DSH Python, or `WHALECHAN_PYTHON` when set. */
export function pythonPath(): string {
  const override = process.env['WHALECHAN_PYTHON']?.trim()
  if (override !== undefined && override !== '') return override
  const home = process.env['DSH_HOME']?.trim() ?? ''
  return home === ''
    ? ''
    : join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
}

/** Skip reason for tests that need the oracle, or false when it is available. */
export function oracleSkip(): string | false {
  if (!existsSync(CHARACTER_ORACLE)) return `frozen oracle not found at ${CHARACTER_ORACLE}`
  const interpreter = pythonPath()
  if (interpreter === '' || !existsSync(interpreter)) {
    return 'set WHALECHAN_PYTHON to the interpreter that can run the oracle'
  }
  return false
}

/**
 * Environment for an oracle run.
 *
 * `PYTHONPATH` plus the opt-in flag install the `magick` stand-in in the oracle
 * process *and* in any interpreter it spawns, which is what lets the reference
 * checks run on a machine without ImageMagick.
 */
function oracleEnv(): Record<string, string> {
  const existing = process.env['PYTHONPATH'] ?? ''
  return {
    ...process.env as Record<string, string>,
    PYTHONPATH: existing === '' ? MAGICK_SHIM : `${MAGICK_SHIM}${process.platform === 'win32' ? ';' : ':'}${existing}`,
    WHALECHAN_MAGICK_SHIM: '1',
    PYTHONIOENCODING: 'utf-8',
  }
}

/** What one oracle invocation concluded. */
export type OracleOutcome =
  | { readonly ok: true; readonly stdout: string }
  /**
   * `stdout` is carried on failure too: the linter reports through its JSON body
   * and signals "there were errors" with a non-zero exit, so dropping stdout
   * would throw away the answer exactly when it matters.
   */
  | { readonly ok: false; readonly error: string; readonly stdout: string; readonly status: number }

/** Run the oracle's `validate-assignment` command on an in-memory assignment. */
export function oracleValidateAssignment(assignment: unknown, scratchFile: string): OracleOutcome {
  writeFileSync(scratchFile, JSON.stringify(assignment, null, 2), 'utf8')
  return runOracle([oracleScript('manage-run.py'), 'validate-assignment', '--assignment', scratchFile])
}

/**
 * Run an arbitrary oracle subcommand.
 * @param args - arguments after the interpreter, starting with the script path or `-c`.
 */
/**
 * Run an arbitrary oracle subcommand.
 * @param args - arguments after the interpreter, starting with the script path or `-c`.
 * @param input - text to feed on stdin; prefer this over argv for payloads, which
 *   hit the Windows command-line limit at around 32 KB.
 */
export function runOracle(args: readonly string[], input?: string): OracleOutcome {
  try {
    const options = input === undefined
      ? { encoding: 'utf8' as const, env: oracleEnv() }
      : { encoding: 'utf8' as const, env: oracleEnv(), input }
    const stdout = execFileSync(pythonPath(), [...args], options)
    return { ok: true, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    const stderr = (failure.stderr ?? '').trim()
    return {
      ok: false,
      error: stderr === '' ? String(failure.message ?? failure.status) : stderr,
      stdout: failure.stdout ?? '',
      status: failure.status ?? 1,
    }
  }
}

/** Run a Python snippet that imports the oracle module; returns its stdout. */
export function runPythonSnippet(
  code: string,
  args: readonly string[] = [],
  input?: string,
): OracleOutcome {
  return runOracle(['-c', code, ...args], input)
}

/**
 * Call one function inside the oracle module with JSON arguments.
 *
 * Not every rule the plugin must reproduce is reachable through the oracle's CLI
 * — `provider_is_exhausted` and `enforce_provider_order` have no subcommand of
 * their own. This runs the oracle's own code, so the comparison is still against
 * the real implementation rather than a restatement of it.
 *
 * The `RunError` class is looked up on the module first and then on a `manage`
 * attribute, because `build-prompt.py` raises the run manager's class rather than
 * one of its own. Anything that is *not* that class is re-raised, so a genuine
 * crash in the oracle still surfaces instead of being reported as a tidy refusal.
 *
 * The payload arrives on **stdin**, not argv: a real assignment is tens of
 * kilobytes and Windows refuses a command line past roughly 32 KB.
 *
 * `namespace` mode wraps the JSON object into a `SimpleNamespace`, which is how
 * the oracle's `cmd_*` entry points expect their argparse result.
 */
const FUNCTION_DRIVER = [
  'import importlib.util, json, sys',
  'from types import SimpleNamespace',
  'spec = importlib.util.spec_from_file_location("manage_run", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'fn = getattr(mod, sys.argv[2])',
  'mode = sys.argv[3]',
  'payload = json.loads(sys.stdin.read())',
  'args = [SimpleNamespace(**payload)] if mode == "namespace" else payload',
  'error_type = getattr(mod, "RunError", None)',
  'if error_type is None:',
  '    error_type = getattr(getattr(mod, "manage", None), "RunError", None)',
  'try:',
  '    result = fn(*args)',
  '    if mode == "none":',
  '        print(json.dumps({"ok": True}))',
  '    else:',
  '        print(json.dumps({"ok": True, "result": result}, default=str))',
  'except Exception as exc:',
  '    if error_type is None or not isinstance(exc, error_type):',
  '        raise',
  '    print(json.dumps({"ok": False, "error": str(exc)}))',
].join('\n')

/** What the oracle's function call concluded. */
export type OracleCall =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string }

/**
 * Call an oracle function.
 * @param name - the function's name in `manage-run.py`.
 * @param args - positional arguments, JSON-serializable.
 * @param wantResult - return the function's value rather than just success.
 */
export function runOracleFunction(
  name: string,
  args: readonly unknown[],
  wantResult = false,
): OracleCall {
  return runOracleModuleFunction(oracleScript('manage-run.py'), name, args, wantResult)
}

/**
 * Call a function inside an arbitrary oracle module.
 *
 * The entry point is selectable because not every rule lives in the same module:
 * the prompt compiler is `build-prompt.py`, which loads the run manager at import
 * time rather than exposing `cmd_*` itself.
 * @param script - absolute path of the module to load.
 * @param name - the function's name in that module.
 * @param args - positional arguments, JSON-serializable.
 * @param wantResult - return the function's value rather than just success.
 */
export function runOracleModuleFunction(
  script: string,
  name: string,
  args: readonly unknown[],
  wantResult = false,
): OracleCall {
  const outcome = runPythonSnippet(
    FUNCTION_DRIVER,
    [script, name, wantResult ? 'full' : 'none'],
    JSON.stringify(args),
  )
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return JSON.parse(outcome.stdout) as OracleCall
}

/** The `error` field of the oracle's stderr JSON, or the raw text. */
export function oracleErrorMessage(outcome: OracleOutcome): string {
  if (outcome.ok) return ''
  try {
    const parsed = JSON.parse(outcome.error) as { error?: string }
    return typeof parsed.error === 'string' ? parsed.error : outcome.error
  } catch {
    return outcome.error
  }
}
