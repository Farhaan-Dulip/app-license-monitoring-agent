import './App.css';

const HotPotLandingPage = () => {
  return (
    <div>
      <header>
        <h1>HotPot</h1>
        <h2>Your modern dining experience</h2>
      </header>
      <section className="hero">
        <h1>Welcome to HotPot</h1>
        <p>Experience comfort food like never before!</p>
      </section>
      <section className="about">
        <h2>About Us</h2>
        <p>At HotPot, we bring families and friends together over flavorful meals, serving dishes with a modern touch.</p>
      </section>
      <section className="menu">
        <h2>Featured Dishes</h2>
        <div className="card"><h3>Savory HotPot</h3><p>Our signature dish with unique flavors.</p></div>
        <div className="card"><h3>Grilled Veggies</h3><p>Fresh seasonal vegetables grilled to perfection.</p></div>
      </section>
      <section className="reservation">
        <h2>Make a Reservation</h2>
        <button className="button" aria-label="Make a reservation">Make a Reservation</button>
      </section>
      <section className="testimonials">
        <h2>Customer Reviews</h2>
        <div className="card"><p>&quot;A delightful experience! The food was amazing.&quot; - Jane</p></div>
        <div className="card"><p>&quot;The atmosphere is warm and inviting!&quot; - John</p></div>
      </section>
      <section className="contact">
        <h2>Contact Us</h2>
        <p>Email: contact@hotpot.com</p>
        <p>Follow us on social media: Facebook | Instagram | Twitter</p>
      </section>
    </div>
  );
};

export default HotPotLandingPage;