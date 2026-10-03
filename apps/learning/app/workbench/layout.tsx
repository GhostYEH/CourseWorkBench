import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { WorkbenchShell } from '../../components/workbench-shell';
import { bootstrapFromEnvironment, getSession } from '../../lib/server/service';
import { readPreferences } from '../../lib/server/state';
import { readWorkbenchState, readWorkbenchMaterials, readWorkbenchProposals, readWorkbenchKnowledge } from '../../lib/server/workbench-data';
import { toKnowledgePointDto, toMaterialDto, toProposalDto } from '../../lib/server/dto';

export const dynamic = 'force-dynamic';

export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) redirect('/no-project');

  const state = readWorkbenchState(session);
  const materials = readWorkbenchMaterials(session).map(toMaterialDto);
  const proposals = readWorkbenchProposals(session).map(toProposalDto);
  const view = readWorkbenchKnowledge(session);
  const knowledge = view.rows.map((point) => ({
    ...toKnowledgePointDto(point),
    admission: view.admissionFor(point.knowledgeId),
  }));
  const preferences = readPreferences(session);

  return (
    <WorkbenchShell
      state={state}
      materials={materials}
      proposals={proposals}
      knowledge={knowledge}
      preferences={preferences}
    >
      {children}
    </WorkbenchShell>
  );
}
