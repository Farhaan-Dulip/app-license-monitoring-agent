import './App.css';

const App = () => {
    return (
        <div>
            <header>
                <h1>Farhan's Restaurant</h1>
                <nav>
                    <ul>
                        <li><a href="#">Home</a></li>
                        <li><a href="#menu">Menu</a></li>
                        <li><a href="#about">About Us</a></li>
                        <li><a href="#testimonials">Testimonials</a></li>
                        <li><a href="#contact">Contact</a></li>
                    </ul>
                </nav>
            </header>
            <section className="hero">
                <h1>Welcome to Farhan's Restaurant</h1>
                <p>Experience the best dining with a touch of warmth.</p>
                <button className="cta-button">Make a Reservation</button>
            </section>
            <section id="menu" className="menu">
                <h2>Our Featured Dishes</h2>
                <div className="menu-items">
                    <div className="menu-item">
                        <h3>Spicy Chicken Curry</h3>
                        <p>A flavorful delight with spices.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Grilled Fish Tacos</h3>
                        <p>Fresh and zesty, served with salsa.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Vegetable Stir Fry</h3>
                        <p>Healthy mix of seasonal vegetables.</p>
                    </div>
                </div>
            </section>
            <section id="about" className="about">
                <h2>About Us</h2>
                <p>At Farhan's, we believe in providing unforgettable dining experiences with our carefully curated menu and inviting atmosphere.</p>
            </section>
            <section id="testimonials" className="testimonials">
                <h2>Customer Testimonials</h2>
                <blockquote>
                    <p>“The food was exquisite and the service top-notch!” — John Doe</p>
                </blockquote>
                <blockquote>
                    <p>“A wonderful experience for the whole family.” — Jane Smith</p>
                </blockquote>
            </section>
            <section id="contact" className="contact">
                <h2>Contact Us</h2>
                <p>For reservations, call us at (123) 456-7890</p>
                <p>Visit us: 123 Food Lane, Flavor Town</p>
            </section>
            <footer>
                <p>Follow us on social media!</p>
                <p>&copy; 2023 Farhan's Restaurant</p>
            </footer>
        </div>
    );
};

export default App;