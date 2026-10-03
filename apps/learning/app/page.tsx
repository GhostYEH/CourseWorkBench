import { redirect } from 'next/navigation';
import { getSession } from '../lib/server/service';

export const dynamic = 'force-dynamic';

export default function Home() {
  redirect(getSession() ? '/workbench' : '/no-project');
}
