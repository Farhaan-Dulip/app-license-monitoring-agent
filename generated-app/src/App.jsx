import React from 'react';
import './App.css';

const App = () => {
    return (
        <div>
            <header>
                <h1>Farhan's Restaurant</h1>
                <nav>
                    <ul>
                        <li><a href="#menu">Menu</a></li>
                        <li><a href="#about">About</a></li>
                        <li><a href="#testimonials">Testimonials</a></li>
                        <li><a href="#contact">Contact</a></li>
                    </ul>
                </nav>
            </header>
            <section className="hero">
                <h1>Welcome to Farhan's Restaurant!</h1>
            </section>
            <section id="menu" className="menu">
                <h2>Featured Dishes</h2>
                <div className="card">Pasta Primavera</div>
                <div className="card">Grilled Salmon</div>
                <div className="card">Chocolate Lava Cake</div>
            </section>
            <section id="about" className="about">
                <h2>About Us</h2>
                <p>At Farhan's, we strive to bring you the freshest ingredients and the finest dining experience.</p>
            </section>
            <section id="testimonials" className="testimonials">
                <h2>What Our Customers Say</h2>
                <div className="card">"Best restaurant in town!" - John Doe</div>
                <div className="card">"A culinary delight!" - Jane Smith</div>
            </section>
            <section id="contact" className="contact">
                <h2>Contact Us</h2>
                <p>For reservations, email us at: reservations@farhansrestaurant.com</p>
            </section>
            <footer>
                <p>Follow us on social media!</p>
                <p>&copy; 2023 Farhan's Restaurant</p>
            </footer>
        </div>
    );
};

export default App;