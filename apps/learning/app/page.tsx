import { redirect } from 'next/navigation';
import { bootstrapFromEnvironment, getSession } from '../lib/server/service';

export const dynamic = 'force-dynamic';

export default function Home() {
  redirect((getSession() ?? bootstrapFromEnvironment()) ? '/workbench' : '/no-project');
}
