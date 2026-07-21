import React from 'react';
import './App.css';

const HotPotLandingPage = () => {
    return (
        <div>
            <header>
                <h1>Welcome to HotPot</h1>
            </header>
            <div className="hero">
                <h1>Experience the Flavors of HotPot!</h1>
                <p>Make your taste buds dance with our exquisite dishes.</p>
                <button className="cta">Make a Reservation</button>
            </div>
            <section className="about">
                <h2>About Us</h2>
                <p>At HotPot, we are dedicated to serving authentic dishes with a modern twist, providing a warm atmosphere for families and friends.</p>
            </section>
            <section className="menu">
                <h2>Menu Preview</h2>
                <div className="menu">
                    <div className="menu-item">
                        <h3>Spicy Noodle Soup</h3>
                        <p>$12.99</p>
                        <p>A flavorful broth with just the right amount of heat.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Szechuan Dumplings</h3>
                        <p>$8.99</p>
                        <p>Delicately spiced and served with a tangy sauce.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Sizzling Hot Pot</h3>
                        <p>$20.99</p>
                        <p>An interactive dining experience with fresh ingredients.</p>
                    </div>
                </div>
            </section>
            <section className="reservation">
                <h2>Reservation Options</h2>
                <p>Reserve your table now and enjoy a delightful evening!</p>
                <button className="cta">Book Now</button>
            </section>
            <section className="testimonials">
                <h2>Customer Testimonials</h2>
                <p>“Best dining experience ever! The staff is incredibly friendly.” - A satisfied customer</p>
            </section>
            <footer>
                <p>Follow us on social media for the latest updates!</p>
                <p>Contact: contact@hotpot.com</p>
            </footer>
        </div>
    );
};

export default HotPotLandingPage;