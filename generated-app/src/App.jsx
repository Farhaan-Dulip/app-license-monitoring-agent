import React from 'react';
import './App.css';

const HotPotLandingPage = () => {
    return (
        <div className="container">
            <div className="hero">
                <h1>Welcome to HotPot</h1>
                <p>Experience modern dining like never before</p>
                <button className="cta-button">Make a Reservation</button>
            </div>
            <div className="section" id="about">
                <h2>About Us</h2>
                <p>HotPot was founded with the mission to provide a unique dining experience filled with flavors and ambiance. Join us for a meal that feels like home.</p>
            </div>
            <div className="section" id="menu">
                <h2>Featured Dishes</h2>
                <div className="grid">
                    <div className="dish">Dish 1</div>
                    <div className="dish">Dish 2</div>
                    <div className="dish">Dish 3</div>
                    <div className="dish">Dish 4</div>
                </div>
            </div>
            <div className="section" id="reservation">
                <h2>Reservation</h2>
                <p>Secure your table now!</p>
                <button className="cta-button">Make a Reservation</button>
            </div>
            <div className="section" id="testimonials">
                <h2>What Our Customers Say</h2>
                <blockquote>
                    “The best dining experience in town!” - John Doe
                </blockquote>
            </div>
            <div className="section" id="contact">
                <h2>Contact Us</h2>
                <p>Address: 123 Flavor St, Food City</p>
                <p>Follow us on social media!</p>
            </div>
        </div>
    );
};

export default HotPotLandingPage;