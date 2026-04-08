export function replaceCargoPackageVersion(source, nextVersion) {
  const packageBlockRegex = /^\[package\][\s\S]*?(?=^\[|\Z)/m;
  const packageBlock = source.match(packageBlockRegex);
  if (!packageBlock) {
    throw new Error('Cargo.toml 缺少 [package] 段');
  }

  const replacedBlock = packageBlock[0].replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${nextVersion}"`,
  );

  if (replacedBlock === packageBlock[0]) {
    throw new Error('Cargo.toml [package] 段缺少 version 字段');
  }

  return source.replace(packageBlock[0], replacedBlock);
}

export function replaceJsonVersion(document, nextVersion) {
  return {
    ...document,
    version: nextVersion,
  };
}
