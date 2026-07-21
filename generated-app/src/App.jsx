import './App.css';

function HotPotLandingPage() {
    return (
        <div className="container">
            <header>
                <h1>Welcome to HotPot</h1>
                <p>Your favorite restaurant for delicious meals.</p>
            </header>
            <section className="hero">
                <h2>Experience the Best Hot Pot in Town!</h2>
                <a href="#reservation" className="btn">Make a Reservation</a>
            </section>
            <section>
                <h2>About Us</h2>
                <p>HotPot is dedicated to bringing you authentic hot pot experiences, catered to food enthusiasts, families, and young adults.</p>
            </section>
            <section>
                <h2>Menu Preview</h2>
                <div className="grid">
                    <div className="menu-item">
                        <h3>Dishes 1</h3>
                        <p>Description about dish 1.</p>
                        <p>$10.99</p>
                    </div>
                    <div className="menu-item">
                        <h3>Dishes 2</h3>
                        <p>Description about dish 2.</p>
                        <p>$12.99</p>
                    </div>
                </div>
            </section>
            <section id="reservation">
                <h2>Make a Reservation</h2>
                <p>Book your table now!</p>
                <form>
                    <input type="text" placeholder="Your Name" aria-label="Your name" required />
                    <input type="email" placeholder="Your Email" aria-label="Your email" required />
                    <input type="date" aria-label="Reservation date" required />
                    <button type="submit" className="btn">Reserve</button>
                </form>
            </section>
            <section>
                <h2>Testimonials</h2>
                <p>See what our customers are saying!</p>
            </section>
            <section>
                <h2>Contact Us</h2>
                <p>Contact us for more information or to book your experience!</p>
            </section>
            <footer>
                <p>Follow us on social media</p>
            </footer>
        </div>
    );
}

export default HotPotLandingPage;