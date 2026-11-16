import type { IProjectService } from "#src/project/contract.js";

export async function projectExample(service: IProjectService): Promise<string> {
  const project = await service.saveProject({
    roots: ["/workspace/frontend", "/workspace/backend"],
  });
  const directories = await service.readProjects();
  if (!directories.some((entry) => entry.id === project.id))
    throw new Error("Project not committed");
  const execution = await service.prepareSession({ projectId: project.id });
  return execution.workspacePath;
}

export async function openFolderExample(service: IProjectService, path: string): Promise<string> {
  return (await service.saveProject({ roots: [path], reuseExistingRoot: true })).id;
}

export async function projectDataPurgeExample(
  service: IProjectService,
  projectId: string,
): Promise<number> {
  const measured = await service.measureProjectData([projectId], "local");
  if ((measured.projects[0]?.sessions ?? 0) === 0) return 0;
  await service.deleteProject(projectId, "local");
  const result = await service.deleteProjectData(projectId, "local");
  return result.freedBytes;
}
