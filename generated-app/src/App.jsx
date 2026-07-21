import React from 'react';
import './App.css';

const EcoFutureLandingPage = () => {
    return (
        <div>
            <header>
                <h1>Welcome to EcoFuture</h1>
                <p>Your journey to a sustainable future begins here.</p>
            </header>
            <div className="container">
                <div className="hero">
                    <h2>Join the Movement</h2>
                </div>
                <section>
                    <h2>About Us</h2>
                    <p>EcoFuture is dedicated to promoting environmental awareness and sustainability.</p>
                </section>
                <section>
                    <h2>Our Initiatives</h2>
                    <p>Learn more about our projects aimed at preserving our planet.</p>
                </section>
                <section>
                    <h2>Get Involved</h2>
                    <a className='cta' href='#'>Volunteer or Donate</a>
                </section>
                <section>
                    <h2>Testimonials</h2>
                    <p>“EcoFuture has changed the way I think about the environment.” - Supporter</p>
                </section>
                <section>
                    <h2>Blog</h2>
                    <p>Stay updated with the latest articles on environmental topics.</p>
                </section>
                <section>
                    <h2>Contact Us</h2>
                    <form>
                        <input type='text' placeholder='Your Name' required />
                        <input type='email' placeholder='Your Email' required />
                        <textarea placeholder='Your Message' required></textarea>
                        <button type='submit' className='cta'>Send Message</button>
                    </form>
                </section>
            </div>
        </div>
    );
};

export default EcoFutureLandingPage;