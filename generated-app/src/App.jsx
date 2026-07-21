import './App.css';

const App = () => {
  return (
    <div>
      <header>
        <h1>Welcome to HotPot!</h1>
        <p>Experience modern dining with a touch of warmth.</p>
      </header>
      <div className="container">
        <section className="about">
          <h2>About Us</h2>
          <p>At HotPot, we believe in creating a delightful experience for families and friends. Our mission is to bring people together through delicious food!</p>
        </section>
        <section className="menu">
          <h2>Featured Dishes</h2>
          <div className="card">
            <h3>Spicy Noodle Bowl</h3>
            <p>A fiery mix of noodles and vegetables.</p>
          </div>
          <div className="card">
            <h3>Grilled Vegetable Platter</h3>
            <p>A colorful assortment of grilled vegetables.</p>
          </div>
        </section>
        <section className="reservations">
          <h2>Make a Reservation</h2>
          <button className="button">Reserve Now</button>
        </section>
        <section className="testimonials">
          <h2>What Our Customers Say</h2>
          <div className="card">
            <h3>Jane D.</h3>
            <p>Loved the ambiance and the food!</p>
          </div>
          <div className="card">
            <h3>Mark C.</h3>
            <p>Best restaurant experience I've had recently.</p>
          </div>
        </section>
        <section className="contact">
          <h2>Contact Us</h2>
          <p>Address: 123 Flavor St, Food City</p>
          <p>Follow us on social media!</p>
        </section>
      </div>
    </div>
  );
};

export default App;