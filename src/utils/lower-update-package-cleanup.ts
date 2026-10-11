import type { LowerUpdateInstallRequest, LowerUpdatePackageCleanupResult } from '../adapters/types';

type ImageVerification = 'succeeded' | 'mismatch' | 'failed';

interface DeploymentCompletionOperations {
  verifyImage: (request: LowerUpdateInstallRequest) => Promise<ImageVerification>;
  cleanupPackages: (request: LowerUpdateInstallRequest) => Promise<LowerUpdatePackageCleanupResult>;
}

interface DeploymentCompletionResult {
  verification: ImageVerification;
  cleanupResult: LowerUpdatePackageCleanupResult | null;
  cleanupError: unknown | null;
}

// 仅接受成功安装保存的请求，镜像确认成功后再清理，清理错误不改变升级结果。
export async function confirmLowerUpdateDeployment(
  installedRequest: LowerUpdateInstallRequest | null,
  operations: DeploymentCompletionOperations,
): Promise<DeploymentCompletionResult> {
  if (!installedRequest) {
    return { verification: 'failed', cleanupResult: null, cleanupError: null };
  }

  const request = { ...installedRequest, auth: { ...installedRequest.auth } };
  const verification = await operations.verifyImage(request);
  if (verification !== 'succeeded') {
    return { verification, cleanupResult: null, cleanupError: null };
  }

  try {
    const cleanupResult = await operations.cleanupPackages(request);
    return { verification, cleanupResult, cleanupError: null };
  } catch (cleanupError) {
    return { verification, cleanupResult: null, cleanupError };
  }
}
