import './App.css';

const dishes = [
  "Charred tomato burrata",
  "Saffron seafood risotto",
  "Wood-fired herb chicken"
];

export default function App() {
  return (
    <main className="page-shell">
      <nav className="nav">
        <strong>Ember & Sage</strong>
        <div>
          <a href="#menu">Menu</a>
          <a href="#story">Story</a>
          <a href="#reserve">Reserve</a>
        </div>
      </nav>

      <section className="hero">
        <p className="eyebrow">restaurant landing page</p>
        <h1>Ember & Sage</h1>
        <p className="lede">warm, refined, appetizing, modern dining for local diners looking for a polished dinner reservation experience.</p>
        <a className="cta" href="#reserve">Reserve a Table</a>
      </section>

      <section id="menu" className="menu-grid">
        {dishes.map((dish) => (
          <article key={dish}>
            <p>Signature</p>
            <h2>{dish}</h2>
            <span>Seasonal ingredients, composed for a memorable table experience.</span>
          </article>
        ))}
      </section>

      <section id="story" className="story">
        <div>
          <p className="eyebrow">Design Sections</p>
          <h2>Figma-created structure converted to React</h2>
        </div>
        <div className="section-list">
          <span>Navigation</span>
              <span>Hero reservation CTA</span>
              <span>Signature dishes</span>
              <span>Chef story</span>
              <span>Private dining CTA</span>
              <span>Footer</span>
        </div>
      </section>

      <section id="reserve" className="reservation">
        <h2>Ready for dinner?</h2>
        <p>Reserve a table for a warm evening of thoughtful food and polished service.</p>
        <button>Reserve a Table</button>
      </section>
    </main>
  );
}
