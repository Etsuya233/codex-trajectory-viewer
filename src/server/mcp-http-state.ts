import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

// The inherited Windows ACL is removed before writing any secrets. Existing paths
// are checked without changing their ACL, including when the operator overrides the directory.
const windowsDirectoryAcl = `
$ErrorActionPreference = 'Stop'
$directory = $env:TRAJECTORY_HTTP_ACL_DIRECTORY
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = Get-Acl -LiteralPath $directory
if ($env:TRAJECTORY_HTTP_ACL_CREATED -eq '1') {
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    $acl.RemoveAccessRuleSpecific($rule)
  }
  foreach ($principal in @($me, $system)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $directory -AclObject $acl
}
foreach ($path in @($directory, (Join-Path $directory 'token'), (Join-Path $directory 'codex-http-mcp.toml'))) {
  if (!(Test-Path -LiteralPath $path)) { continue }
  $attributes = (Get-Item -LiteralPath $path -Force).Attributes
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Credential path is a reparse point' }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($me.Value, $system.Value)) {
    throw 'Unexpected credential owner'
  }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($me.Value, $system.Value)) {
      throw 'Credential path grants access to another Windows principal'
    }
  }
}
`;

async function checkStateDirectory(directory: string, create: boolean) {
  const created = create ? await mkdir(directory, { recursive: true, mode: 0o700 }) : undefined;
  if (!(await lstat(directory)).isDirectory()) throw new Error('HTTP MCP state path must be a directory');
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    try {
      await promisify(execFile)(powershell, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsDirectoryAcl, 'utf16le').toString('base64'),
      ], {
        env: { ...env, TRAJECTORY_HTTP_ACL_DIRECTORY: directory, TRAJECTORY_HTTP_ACL_CREATED: created ? '1' : '0' },
        windowsHide: true,
      });
    } catch (error) {
      throw new Error('Cannot secure the HTTP MCP state directory. Choose a new private directory.', { cause: error });
    }
  } else {
    for (const path of [directory, join(directory, 'token'), join(directory, 'codex-http-mcp.toml')]) {
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
          throw new Error('HTTP MCP state paths must be private and owned by the current user');
        }
      } catch (error) {
        if (path === directory || errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
}

export async function getHttpMcpToken(directory: string, create: boolean) {
  const tokenPath = join(directory, 'token');
  await checkStateDirectory(directory, create);
  if (create) {
    const temporary = join(directory, `token-${randomBytes(16).toString('hex')}`);
    await writeFile(temporary, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    try {
      // Publish a complete file. Competing first starts keep the first token.
      await link(temporary, tokenPath);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary);
    }
  }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local HTTP MCP token file');
  return token;
}

export async function writeHttpMcpConfig(directory: string, endpoint: string, token: string) {
  const file = join(directory, 'codex-http-mcp.toml');
  const temporary = join(directory, `config-${randomBytes(16).toString('hex')}`);
  const snippet = '[mcp_servers.local_trajectory_http]\n'
    + `url = "${endpoint}/mcp"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
  await writeFile(temporary, snippet, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  return file;
}
