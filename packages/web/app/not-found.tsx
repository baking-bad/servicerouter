const NotFound = () => (
  <div className="container">
    <section className="section stack">
      <span className="eyebrow">404</span>
      <h1>Not found</h1>
      <p className="lead">There is no page here. The service may have been removed from the catalog.</p>
      <div className="row"><a className="button button-primary" href="/discover">Discover services</a><a className="button" href="/">Home</a></div>
    </section>
  </div>
);

export default NotFound;
