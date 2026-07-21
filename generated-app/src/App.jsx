import React from 'react';
import './App.css';

const App = () => {
    return (
        <div>
            <header>
                <h1>Culinary Delights</h1>
                <h2>Your Destination for Flavor</h2>
            </header>
            <div className="hero"></div>
            <div className="container">
                <section className="about section">
                    <h2>About Us</h2>
                    <p>We bring you the best culinary experiences with our handcrafted meals.</p>
                </section>
                <section className="menu section">
                    <h2>Menu Overview</h2>
                    <div className="card">
                        <h3>Signature Dish</h3>
                        <p>A taste sensation just for you!</p>
                    </div>
                </section>
                <section className="testimonials section">
                    <h2>What Our Customers Say</h2>
                    <div className="card">
                        <p>&quot;The best dining experience in town!&quot;</p>
                        <p>- Happy Customer</p>
                    </div>
                </section>
                <section className="contact section">
                    <h2>Contact Information</h2>
                    <p>Email: info@culinarydelights.com</p>
                    <p>Phone: (123) 456-7890</p>
                </section>
                <section className="location section">
                    <h2>Find Us Here</h2>
                    <p>Location map integration coming soon!</p>
                </section>
                <button>Make a Reservation</button>
            </div>
        </div>
    );
};

export default App;