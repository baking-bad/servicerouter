import { ServicePage } from '../../../../src/console/ui/pages/ServicePage';

const ConsoleServicePage = async ({ params }: { readonly params: Promise<{ readonly id: string }> }) => <ServicePage id={(await params).id} />;

export default ConsoleServicePage;
