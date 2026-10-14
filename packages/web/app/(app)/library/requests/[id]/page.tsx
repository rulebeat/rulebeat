import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { listCategories } from '@/lib/db/categories';
import { getLibraryRequest } from '@/lib/db/library-requests';
import { requestDetail } from '@/lib/library-request-view';
import { getPageAccess } from '@/lib/page-access';
import { mayAct } from '@/lib/rbac';
import { splitLearnMore } from '@/lib/rule-description';
import { LibraryRequestReviewClient } from './library-request-review-client';

/**
 * One Library request, for a reviewer. Anyone who may not write the library reads the same 404 as for a
 * request that does not exist, so the page tells them nothing about which requests there are.
 */
export default async function LibraryRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, access } = await getPageAccess();
  if (!user || !mayAct(access, 'rules:write')) notFound();

  const request = await getLibraryRequest(decodeURIComponent(id));
  if (!request) notFound();

  const detail = await requestDetail(request);
  return (
    <>
      <Header title={detail.name} description={splitLearnMore(detail.description).text || undefined} />
      <LibraryRequestReviewClient
        request={detail}
        rejectionReason={request.rejectionReason}
        categories={await listCategories()}
      />
    </>
  );
}
