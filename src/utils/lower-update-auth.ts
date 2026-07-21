export interface LowerUpdateSudoPasswordOptions {
  sshAuthMethod: 'password' | 'certificate';
  sshPassword: string;
  reuseSshPassword: boolean;
  sudoPassword: string;
}

export function resolveLowerUpdateSudoPassword({
  sshAuthMethod,
  sshPassword,
  reuseSshPassword,
  sudoPassword,
}: LowerUpdateSudoPasswordOptions): string {
  if (sshAuthMethod === 'password' && reuseSshPassword) {
    return sshPassword;
  }
  return sudoPassword;
}
