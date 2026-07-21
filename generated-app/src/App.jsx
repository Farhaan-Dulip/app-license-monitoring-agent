import './App.css';

function App() {
    return (
        <div>
            <header>
                <h1>Welcome to HotPot!</h1>
                <h2>Experience the warmth of delicious meals</h2>
            </header>
            <div className="container">
                <section className="hero">
                    <h2>Delicious HotPot Dishes Awaiting You</h2>
                </section>
                <section className="about">
                    <h2>About Us</h2>
                    <p>HotPot offers a unique dining experience combining traditional recipes with a modern twist.</p>
                </section>
                <section className="menu">
                    <h2>Our Menu</h2>
                    <p>Explore our range of exquisite dishes available for you at HotPot.</p>
                </section>
                <section className="reservation">
                    <h2>Make a Reservation</h2>
                    <form>
                        <div className="form-group">
                            <input type="text" className="form-control" placeholder="Your Name" required />
                        </div>
                        <div className="form-group">
                            <input type="email" className="form-control" placeholder="Your Email" required />
                        </div>
                        <div className="form-group">
                            <input type="date" className="form-control" required />
                        </div>
                        <div className="form-group">
                            <input type="time" className="form-control" required />
                        </div>
                        <button type="submit" className="btn">Reserve Now</button>
                    </form>
                </section>
                <section className="testimonials">
                    <h2>Customer Testimonials</h2>
                    <p>What our customers say about us.</p>
                </section>
                <section className="contact">
                    <h2>Contact Us</h2>
                    <p>Get in touch with us for more information.</p>
                </section>
            </div>
            <footer className="footer">
                <p>&copy; 2023 HotPot. All rights reserved.</p>
            </footer>
        </div>
    );
}

export default App;