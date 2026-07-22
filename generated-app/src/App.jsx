import React from 'react';
import './App.css';

const App = () => {
    return (
        <div>
            <header>
                <h1>Farhan's Restaurant</h1>
                <nav>
                    <a href="#">Home</a>
                    <a href="#menu">Menu</a>
                    <a href="#about">About Us</a>
                    <a href="#contact">Contact</a>
                </nav>
            </header>
            <section className="hero">
                <h2>Welcome to Farhan's Restaurant</h2>
                <p>Your gourmet experience awaits.</p>
                <div className="cta">
                    <button>Make a Reservation</button>
                </div>
            </section>
            <section id="menu" className="menu">
                <h2>Featured Dishes</h2>
                <div className="dish">Pasta Primavera</div>
                <div className="dish">Grilled Salmon</div>
                <div className="dish">Cheeseburger</div>
                <div className="dish">Tiramisu</div>
            </section>
            <section id="about" className="about">
                <h2>About Us</h2>
                <p>At Farhan's Restaurant, we pride ourselves on using fresh ingredients to create unique dishes that will tantalize your taste buds.</p>
            </section>
            <section className="testimonials">
                <h2>Testimonials</h2>
                <p>“Best food I’ve ever had!” - A satisfied customer</p>
                <p>“A delightful experience from start to finish!” - Another happy diner</p>
            </section>
            <section id="contact" className="contact">
                <h2>Contact Us</h2>
                <p>Address: 123 Main St, Springfield</p>
                <p>Email: contact@farhansrestaurant.com</p>
            </section>
            <footer>
                <p>Follow us on social media!</p>
                <p>&copy; 2023 Farhan's Restaurant</p>
            </footer>
        </div>
    );
};

export default App;