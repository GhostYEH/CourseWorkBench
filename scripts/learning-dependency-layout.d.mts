export interface PackageIdentity {
  name: string;
  identity: string;
}

export interface NamedPackageIdentity {
  name: string;
  identity: string;
}

export function readPackageIdentity(packagePath: string): PackageIdentity | null;

export function packageNodeModulesDir(packagePath: string): string;

export function chooseRootPackageVersions(
  directPackages: readonly NamedPackageIdentity[],
  dependencyEdges: readonly NamedPackageIdentity[],
): Map<string, string>;

export function resolveInstalledPackageIdentity(
  fromPackagePath: string,
  packageName: string,
  serviceRoot: string,
): string | null;

export function needsLocalPackage(
  fromPackagePath: string,
  packageName: string,
  requestedIdentity: string,
  serviceRoot: string,
): boolean;

export function assertPackageSourceNotActive(
  sourcePath: string,
  activeSourceInstances: ReadonlySet<string>,
): void;
